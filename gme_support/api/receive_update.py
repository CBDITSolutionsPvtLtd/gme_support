import frappe
import requests
import re
from frappe.utils import now_datetime, get_url, strip_html

CBDIT_VENDOR_URL = "https://cbditprod.getmyerp.com"

DEFAULT_PRIORITY_OPTIONS = ["Low", "Medium", "High", "Urgent"]
DEFAULT_STATUS_OPTIONS = ["Open", "Replied", "Resolved", "Closed", "Hold"]
DEFAULT_FEEDBACK_OPTIONS = ["Satisfied", "Not Satisfied", "Issue Resolved", "Need Follow Up"]


def _make_absolute(content, base_url):
    if not content:
        return content

    base = (base_url or "").rstrip("/")

    content = re.sub(
        r'(src=["\'])(/(?:private/)?files/[^"\']+)(["\'])',
        lambda m: f'{m.group(1)}{base}{m.group(2)}{m.group(3)}',
        content
    )
    content = re.sub(
        r'(href=["\'])(/(?:private/)?files/[^"\']+)(["\'])',
        lambda m: f'{m.group(1)}{base}{m.group(2)}{m.group(3)}',
        content
    )
    return content


def _append_message(doc, sender, sender_name, sender_type, message, posted_on=None):
    doc.append("messages", {
        "sender": sender or "",
        "sender_name": sender_name or "",
        "sender_type": sender_type or "TR_C",
        "message": message or "",
        "posted_on": posted_on or str(now_datetime())
    })


def _message_exists(doc, sender, sender_type, message, posted_on):
    for row in doc.get("messages") or []:
        if (
            (row.sender or "") == (sender or "")
            and (row.sender_type or "") == (sender_type or "")
            and (row.message or "") == (message or "")
            and str(row.posted_on or "") == str(posted_on or "")
        ):
            return True
    return False


def _get_vendor_options(api_method, fallback_list):
    try:
        resp = requests.get(
            f"{CBDIT_VENDOR_URL}/api/method/{api_method}",
            timeout=15
        )
        data = resp.json().get("message", [])

        if isinstance(data, list) and data:
            return data

        return fallback_list
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"Vendor Option Fetch Failed: {api_method}"
        )
        return fallback_list


@frappe.whitelist()
def push_new_ticket_to_vendor(ticket_name):
    doc = frappe.get_doc("GME Helpdesk Ticket", ticket_name)
    doc.check_permission("read")

    site_url = get_url()

    payload = {
        "ticket_name": doc.name,
        "subject": doc.subject,
        "description": _make_absolute(doc.description or "", site_url),
        "priority": doc.priority,
        "raised_by": doc.raised_by or frappe.session.user,
        "site_url": site_url
    }

    try:
        resp = requests.post(
            f"{CBDIT_VENDOR_URL}/api/method/cbdit_custom.custom_api.gmeticket.receive_new_ticket",
            json=payload,
            timeout=20
        )

        result = resp.json().get("message", {})
        if result.get("status") in ("created", "already_exists") and result.get("hd_ticket_id"):
            if doc.gme_ticket_id != result.get("hd_ticket_id"):
                frappe.db.set_value("GME Helpdesk Ticket", doc.name, "gme_ticket_id", result.get("hd_ticket_id"))
                frappe.db.commit()

            return {
                "status": "success",
                "gme_ticket_id": result.get("hd_ticket_id")
            }

        frappe.log_error(
            title="Push New Ticket To Vendor Failed",
            message=f"Payload: {payload}\nResponse: {result}"
        )
        return {"status": "error", "response": result}

    except Exception:
        frappe.log_error(frappe.get_traceback(), "Push New Ticket To Vendor Exception")
        return {"status": "error", "message": frappe.get_traceback()}


@frappe.whitelist()
def get_ticket_messages(ticket_name):
    doc = frappe.get_doc("GME Helpdesk Ticket", ticket_name)
    doc.check_permission("read")

    return {
        "instance_sender_type": "TR_C",
        "messages": [
            {
                "sender": row.sender,
                "sender_name": row.sender_name,
                "sender_type": row.sender_type,
                "message": row.message,
                "posted_on": str(row.posted_on or "")
            }
            for row in (doc.get("messages") or [])
        ]
    }


@frappe.whitelist()
def add_ticket_message(ticket_name, message):
    doc = frappe.get_doc("GME Helpdesk Ticket", ticket_name)
    doc.check_permission("write")

    raw_text = strip_html(message or "").strip()
    if not raw_text and "<img" not in (message or "") and "<a" not in (message or ""):
        frappe.throw("Message is required.")

    if not doc.gme_ticket_id:
        frappe.throw("ERP ticket is not linked yet. Please save the ticket first.")

    sender = frappe.session.user
    sender_name = frappe.db.get_value("User", sender, "full_name") or sender
    sender_type = "TR_C"
    posted_on = str(now_datetime())
    safe_message = _make_absolute(message, get_url())

    if not _message_exists(doc, sender, sender_type, safe_message, posted_on):
        _append_message(doc, sender, sender_name, sender_type, safe_message, posted_on)
        doc.save(ignore_permissions=True)
        frappe.db.commit()

    payload = {
        "customer_ticket_id": doc.name,
        "ticket_name": doc.gme_ticket_id,
        "sender": sender,
        "sender_name": sender_name,
        "sender_type": sender_type,
        "message": safe_message,
        "posted_on": posted_on,
        "site_url": get_url()
    }

    try:
        resp = requests.post(
            f"{CBDIT_VENDOR_URL}/api/method/cbdit_custom.custom_api.gmeticket.receive_hd_ticket_message",
            json=payload,
            timeout=15
        )
        try:
            result = resp.json().get("message", {})
        except Exception:
            result = {"raw_text": resp.text}

        if isinstance(result, dict) and result.get("status") not in ("success", "ok"):
            frappe.log_error(
                title="Client to Vendor Message Push Failed",
                message=f"Payload: {payload}\nResponse: {result}"
            )
    except Exception:
        frappe.log_error(frappe.get_traceback(), "Client to Vendor Message Push Exception")

    frappe.publish_realtime("gme_customer_ticket_message_added", {"ticket_name": doc.name})
    return {"status": "success"}


@frappe.whitelist(allow_guest=True)
def receive_ticket_message(ticket_name=None, sender=None, sender_name=None, sender_type=None,
                           message=None, posted_on=None, site_url=None):
    if not ticket_name or not frappe.db.exists("GME Helpdesk Ticket", ticket_name):
        return {"status": "not_found"}

    doc = frappe.get_doc("GME Helpdesk Ticket", ticket_name)
    safe_message = _make_absolute(message or "", site_url or CBDIT_VENDOR_URL)
    final_sender_type = sender_type or "TS_V"
    final_posted_on = posted_on or str(now_datetime())

    if not _message_exists(doc, sender, final_sender_type, safe_message, final_posted_on):
        _append_message(doc, sender, sender_name, final_sender_type, safe_message, final_posted_on)
        doc.save(ignore_permissions=True)
        frappe.db.commit()

    frappe.publish_realtime("gme_customer_ticket_message_added", {"ticket_name": doc.name})
    return {"status": "success", "ticket_name": doc.name}


@frappe.whitelist(allow_guest=True)
def receive_ticket_update(ticket_name, status=None, priority=None, solved_date=None, resolution_time=None):
    try:
        if not frappe.db.exists("GME Helpdesk Ticket", ticket_name):
            return {"status": "not_found", "ticket_name": ticket_name}

        doc = frappe.get_doc("GME Helpdesk Ticket", ticket_name)

        if status is not None:
            doc.status = status
        if priority is not None:
            doc.priority = priority
        if solved_date is not None:
            doc.solved_date = solved_date
        if resolution_time is not None:
            doc.resolution_time = resolution_time

        doc.save(ignore_permissions=True)
        frappe.db.commit()

        return {"status": "updated", "ticket_name": doc.name}
    except Exception:
        frappe.log_error(frappe.get_traceback(), "receive_ticket_update Error")
        return {"status": "error", "message": frappe.get_traceback()}


@frappe.whitelist(allow_guest=True)
def receive_comment_update(ticket_name=None, action=None, reply_id=None, replied_by=None, replied_on=None, message=None):
    return {"status": "ok"}


@frappe.whitelist()
def get_priority_options():
    return _get_vendor_options(
        "cbdit_custom.custom_api.gmeticket.get_priority_options",
        DEFAULT_PRIORITY_OPTIONS
    )


@frappe.whitelist()
def get_status_options():
    return _get_vendor_options(
        "cbdit_custom.custom_api.gmeticket.get_status_options",
        DEFAULT_STATUS_OPTIONS
    )


@frappe.whitelist()
def get_feedback_options():
    return _get_vendor_options(
        "cbdit_custom.custom_api.gmeticket.get_feedback_options",
        DEFAULT_FEEDBACK_OPTIONS
    )