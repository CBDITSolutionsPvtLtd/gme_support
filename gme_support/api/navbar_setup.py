import frappe
from frappe.utils import get_url


def after_migrate():
    update_help_dropdown()


def update_help_dropdown():
    navbar_settings = frappe.get_single("Navbar Settings")

    hide_labels = {
        "Documentation",
        "User Forum",
        "Frappe School",
        "Report an Issue",
        "Frappe Support",
    }

    site_url = get_url()
    gme_route = f"{site_url}/app/gme-support-portal"

    gme_row = None
    updated = False

    for row in navbar_settings.help_dropdown:
        if row.item_label in hide_labels and not row.hidden:
            row.hidden = 1
            updated = True

        if row.item_label == "GME Support":
            gme_row = row

    if gme_row:
        if gme_row.item_type != "Route":
            gme_row.item_type = "Route"
            updated = True

        if gme_row.route != gme_route:
            gme_row.route = gme_route
            updated = True

        if gme_row.hidden:
            gme_row = gme_row
            gme_row.hidden = 0
            updated = True
    else:
        navbar_settings.append("help_dropdown", {
            "item_label": "GME Support",
            "item_type": "Route",
            "route": gme_route,
            "hidden": 0,
        })
        updated = True

    if updated:
        navbar_settings.save(ignore_permissions=True)
        frappe.db.commit()