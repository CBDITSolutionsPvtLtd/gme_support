import frappe
from frappe.utils import add_days, today, getdate
from collections import Counter
import re
import datetime as dt


def is_manager():
    roles = frappe.get_roles(frappe.session.user)
    return "GME Ticket Manager" in roles or "System Manager" in roles


def build_filters(users=None):
    if is_manager():
        if users and users != "__all__":
            if isinstance(users, str):
                users = [users]
            return {"raised_by": ["in", users]}
        return {}
    return {"raised_by": frappe.session.user}


@frappe.whitelist()
def get_user_list():
    if not is_manager():
        fn = frappe.db.get_value("User", frappe.session.user, "full_name") or frappe.session.user
        return [{"value": frappe.session.user, "label": fn}]
    users = frappe.db.sql("""
        SELECT DISTINCT raised_by FROM `tabGME Helpdesk Ticket`
        WHERE raised_by IS NOT NULL AND raised_by != ''
        ORDER BY raised_by
    """, as_dict=True)
    result = [{"value": "__all__", "label": "All Users"}]
    for u in users:
        fn = frappe.db.get_value("User", u.raised_by, "full_name") or u.raised_by
        result.append({"value": u.raised_by, "label": fn + " (" + u.raised_by + ")"})
    return result


def _period_key(d, period):
    if period == "daily":
        return str(d)
    elif period == "weekly":
        return str(d - dt.timedelta(days=d.weekday()))
    elif period == "yearly":
        return str(d.year)
    else:  # monthly (default)
        return "{}-{:02d}".format(d.year, d.month)


@frappe.whitelist()
def get_dashboard_data(users=None, period="monthly"):
    filters = build_filters(users)

    all_tickets = frappe.get_all(
        "GME Helpdesk Ticket", filters=filters,
        fields=["name", "status", "priority", "raised_by",
                "posting_date", "solved_date", "resolution_time", "subject"]
    )

    status_map   = {}
    priority_map = {}
    user_map     = {}
    resolution_times = []
    all_subjects = []
    # timeline per user: { user_email: { period_key: count } }
    user_timeline = {}
    all_timeline  = {}

    for t in all_tickets:
        s = (t.get("status") or "Open").strip()
        status_map[s] = status_map.get(s, 0) + 1

        p = (t.get("priority") or "Medium").strip()
        priority_map[p] = priority_map.get(p, 0) + 1

        u = t.get("raised_by") or "Unknown"
        user_map[u] = user_map.get(u, 0) + 1

        if t.get("resolution_time"):
            try:
                resolution_times.append(int(t["resolution_time"]))
            except Exception:
                pass

        all_subjects.append((t.get("subject") or "").lower())

        pd = t.get("posting_date")
        if pd:
            try:
                d_obj = getdate(pd)
                key = _period_key(d_obj, period)
                all_timeline[key] = all_timeline.get(key, 0) + 1
                if u not in user_timeline:
                    user_timeline[u] = {}
                user_timeline[u][key] = user_timeline[u].get(key, 0) + 1
            except Exception:
                pass

    avg_resolution = int(sum(resolution_times) / len(resolution_times)) \
        if resolution_times else 0

    ov_f = dict(filters)
    ov_f["status"]       = ["in", ["Open", "Replied"]]
    ov_f["posting_date"] = ["<", add_days(today(), -3)]
    overdue_count = frappe.db.count("GME Helpdesk Ticket", filters=ov_f)

    # Keywords
    stop = {
        "the","a","an","is","in","of","for","to","and","or","on","at","with","not","by",
        "are","was","has","have","be","this","that","it","as","from","but","can","will",
        "please","hi","hello","dear","sir","we","i","my","me","our","us","you","your",
        "get","got","need","issue","problem","error","unable","re","new"
    }
    words = []
    for subj in all_subjects:
        for tok in re.findall(r"[a-z]{3,}", subj):
            if tok not in stop:
                words.append(tok)
    word_counts = Counter(words).most_common(10)

    top_users = sorted(user_map.items(), key=lambda x: x[1], reverse=True)[:10]
    top_users_labeled = []
    for email, count in top_users:
        fn = frappe.db.get_value("User", email, "full_name") or email
        top_users_labeled.append({"user": email, "label": fn, "count": count})

    # Build sorted timeline labels (union of all keys)
    all_keys = sorted(set(all_timeline.keys()))

    # Per-user timeline series for chart
    user_series = []
    for email, tmap in user_timeline.items():
        fn = frappe.db.get_value("User", email, "full_name") or email.split("@")[0]
        user_series.append({
            "user"  : email,
            "label" : fn,
            "values": [tmap.get(k, 0) for k in all_keys]
        })

    return {
        "total"          : len(all_tickets),
        "status_map"     : status_map,
        "priority_map"   : priority_map,
        "top_users"      : top_users_labeled,
        "avg_resolution" : avg_resolution,
        "overdue_count"  : overdue_count,
        "word_counts"    : word_counts,
        "timeline_keys"  : all_keys,
        "timeline_all"   : [all_timeline.get(k, 0) for k in all_keys],
        "user_series"    : user_series,
        "is_manager"     : is_manager(),
        "current_user"   : frappe.session.user,
    }


@frappe.whitelist()
def get_tickets(users=None, status=None, page=1, page_length=25):
    filters = build_filters(users)
    if status and status != "All":
        filters["status"] = status
    tickets = frappe.get_all(
        "GME Helpdesk Ticket", filters=filters,
        fields=["name", "subject", "status", "priority",
                "raised_by", "posting_date", "gme_ticket_id", "resolution_time"],
        order_by="modified desc",
        start=(int(page) - 1) * int(page_length),
        page_length=int(page_length)
    )
    total = frappe.db.count("GME Helpdesk Ticket", filters=filters)
    return {"tickets": tickets, "total": total}