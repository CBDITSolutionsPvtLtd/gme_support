import frappe
import requests
import re
from frappe.model.document import Document
from frappe.model.naming import make_autoname
from frappe.utils import now_datetime

CBDIT_BASE_URL = "https://cbditprod.getmyerp.com"

VENDOR_SENDER_TYPE = "TS_V"
CLIENT_SENDER_TYPE = "TR_C"


def _make_description_absolute(description, site_url):
    if not description:
        return description

    base = (site_url or "").rstrip("/")

    description = re.sub(
        r'(src=["\'])(/(?:private/)?files/[^"\']+)(["\'])',
        lambda m: f'{m.group(1)}{base}{m.group(2)}{m.group(3)}',
        description
    )
    description = re.sub(
        r'(href=["\'])(/(?:private/)?files/[^"\']+)(["\'])',
        lambda m: f'{m.group(1)}{base}{m.group(2)}{m.group(3)}',
        description
    )
    return description


def _vendor_site():
    return frappe.utils.get_url().rstrip("/") == CBDIT_BASE_URL.rstrip("/")


def _current_sender_type():
    return VENDOR_SENDER_TYPE if _vendor_site() else CLIENT_SENDER_TYPE


def _remote_receive_endpoint():
    if _vendor_site():
        return None
    return f"{CBDIT_BASE_URL}/api/method/gme_support.api.receive_update.receive_ticket_message"


def _strip_message(message):
    return (message or "").strip()


def _append_message_row(doc, sender, sender_name, sender_type, message, posted_on=None):
    posted_on = posted_on or str(now_datetime())
    doc.append("messages", {
        "sender": sender or "",
        "sender_name": sender_name or "",
        "sender_type": sender_type or "",
        "message": message or "",
        "posted_on": posted_on
    })


def _message_exists(doc, sender, sender_type, message, posted_on):
    for row in doc.messages or []:
        if (
            (row.sender or "") == (sender or "")
            and (row.sender_type or "") == (sender_type or "")
            and (row.message or "") == (message or "")
            and str(row.posted_on or "") == str(posted_on or "")
        ):
            return True
    return False


def _push_message_to_remote(ticket_name, gme_ticket_id, site_url, sender, sender_name, sender_type, message, posted_on):
    endpoint = _remote_receive_endpoint()
    if not endpoint:
        return

    try:
        requests.post(
            endpoint,
            json={
                "ticket_name": ticket_name,
                "gme_ticket_id": gme_ticket_id,
                "site_url": site_url,
                "sender": sender,
                "sender_name": sender_name,
                "sender_type": sender_type,
                "message": message,
                "posted_on": posted_on
            },
            timeout=20
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), "GME Message Push Exception")


class GMEHelpdeskTicket(Document):

    def autoname(self):
        company_abbr = frappe.db.get_value("Company", {}, "abbr", order_by="creation asc") or "GME"
        from datetime import datetime
        mm_yy = datetime.now().strftime("%m%y")
        self.name = make_autoname(f"{company_abbr}-{mm_yy}-.##", doc=self)

    def before_insert(self):
        self.raised_by = frappe.session.user
        self.site_url = frappe.utils.get_url()

    def after_insert(self):
        self._push_ticket_to_cbdit()

    def on_update(self):
        if not self.is_new():
            self._push_feedback_to_cbdit()

    def _push_ticket_to_cbdit(self):
        site_url = self.site_url or frappe.utils.get_url()
        description = _make_description_absolute(self.description or "", site_url)

        payload = {
            "ticket_name": self.name,
            "subject": self.subject,
            "description": description,
            "priority": self.priority or "Medium",
            "raised_by": self.raised_by,
            "site_url": site_url
        }

        try:
            resp = requests.post(
                f"{CBDIT_BASE_URL}/api/method/cbdit_custom.custom_api.gmeticket.receive_new_ticket",
                json=payload,
                timeout=15
            )
            result = resp.json().get("message", {})

            if result.get("status") == "created" and result.get("hd_ticket_id"):
                frappe.db.set_value("GME Helpdesk Ticket", self.name, "gme_ticket_id", result["hd_ticket_id"])
                frappe.db.commit()

            elif result.get("status") == "error":
                frappe.log_error(
                    f"cbditprod error:\n{result.get('message')}",
                    "GME Ticket Push - cbditprod Error"
                )
            elif result.get("status") not in ("created", "already_exists"):
                frappe.log_error(
                    f"Unexpected response: {result}",
                    "GME Ticket Push Failed"
                )

        except Exception:
            frappe.log_error(frappe.get_traceback(), "GME Ticket Push Exception")

    def _push_feedback_to_cbdit(self):
        if not any([self.feedback_rating, self.feedback_option, self.feedback_extra]):
            return

        before = self.get_doc_before_save()
        if before:
            feedback_changed = (
                before.get("feedback_rating") != self.feedback_rating
                or before.get("feedback_option") != self.feedback_option
                or before.get("feedback_extra") != self.feedback_extra
            )
            if not feedback_changed:
                return

        try:
            resp = requests.post(
                f"{CBDIT_BASE_URL}/api/method/cbdit_custom.custom_api.gmeticket.receive_feedback",
                json={
                    "ticket_name": self.name,
                    "site_url": self.site_url,
                    "feedback_rating": self.feedback_rating,
                    "feedback_option": self.feedback_option or "",
                    "feedback_extra": self.feedback_extra or ""
                },
                timeout=10
            )
            result = resp.json().get("message", {})
            if result.get("status") not in ("feedback_received",):
                frappe.log_error(
                    f"Feedback push failed: {result}",
                    "GME Feedback Push Failed"
                )

        except Exception:
            frappe.log_error(frappe.get_traceback(), "GME Feedback Push Exception")


@frappe.whitelist()
def add_ticket_message(ticket_name, message):
    if not frappe.db.exists("GME Helpdesk Ticket", ticket_name):
        frappe.throw(f"Ticket '{ticket_name}' not found.")

    message = _strip_message(message)
    if not message:
        frappe.throw("Message is required.")

    doc = frappe.get_doc("GME Helpdesk Ticket", ticket_name)
    doc.check_permission("write")

    sender = frappe.session.user
    sender_name = frappe.db.get_value("User", sender, "full_name") or sender
    sender_type = _current_sender_type()
    posted_on = str(now_datetime())

    site_url = doc.site_url or frappe.utils.get_url()
    safe_message = _make_description_absolute(message, site_url)

    _append_message_row(doc, sender, sender_name, sender_type, safe_message, posted_on)
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    _push_message_to_remote(
        ticket_name=doc.name,
        gme_ticket_id=doc.gme_ticket_id,
        site_url=doc.site_url,
        sender=sender,
        sender_name=sender_name,
        sender_type=sender_type,
        message=safe_message,
        posted_on=posted_on
    )

    frappe.publish_realtime(
        event="gme_ticket_message_added",
        message={"ticket_name": doc.name},
        user=frappe.session.user
    )

    return {
        "status": "success",
        "ticket_name": doc.name,
        "posted_on": posted_on
    }


@frappe.whitelist()
def get_ticket_messages(ticket_name):
    if not frappe.db.exists("GME Helpdesk Ticket", ticket_name):
        frappe.throw(f"Ticket '{ticket_name}' not found.")

    doc = frappe.get_doc("GME Helpdesk Ticket", ticket_name)
    doc.check_permission("read")

    return {
        "instance_sender_type": _current_sender_type(),
        "messages": [
            {
                "sender": row.sender,
                "sender_name": row.sender_name,
                "sender_type": row.sender_type,
                "message": row.message,
                "posted_on": str(row.posted_on or "")
            }
            for row in (doc.messages or [])
        ]
    }
