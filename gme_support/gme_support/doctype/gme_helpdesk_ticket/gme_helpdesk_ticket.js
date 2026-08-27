frappe.ui.form.on("GME Helpdesk Ticket", {
    onload(frm) {
        load_client_autocomplete_options(frm);
    },

    refresh(frm) {
        load_client_autocomplete_options(frm);

        frm.toggle_display("messages", false);
        if (frm.fields_dict.new_message) frm.toggle_display("new_message", false);

        frm.add_custom_button("← Support Portal", function () {
            frappe.set_route("gme-support-portal");
        });

        if (frm.is_new()) {
            render_new_ticket_placeholder(frm);
            return;
        }

        render_client_chat(frm);
        bind_client_realtime(frm);
    },

    after_save(frm) {
        if (!frm.doc.gme_ticket_id) {
            ensure_vendor_ticket_link(frm).then(() => {
                render_client_chat(frm);
            });
        }
    }
});

function load_client_autocomplete_options(frm) {
    frappe.call({
        method: "gme_support.api.receive_update.get_priority_options",
        callback: function (r) {
            if (r.message && frm.fields_dict.priority) {
                frm.fields_dict.priority.set_data(r.message);
            }
        }
    });

    frappe.call({
        method: "gme_support.api.receive_update.get_status_options",
        callback: function (r) {
            if (r.message && frm.fields_dict.status) {
                frm.fields_dict.status.set_data(r.message);
            }
        }
    });

    frappe.call({
        method: "gme_support.api.receive_update.get_feedback_options",
        callback: function (r) {
            if (r.message && frm.fields_dict.feedback_option) {
                frm.fields_dict.feedback_option.set_data(r.message);
            }
        }
    });
}

function ensure_vendor_ticket_link(frm) {
    return new Promise((resolve) => {
        if (frm.is_new()) {
            resolve();
            return;
        }

        if (frm.doc.gme_ticket_id) {
            resolve();
            return;
        }

        frappe.call({
            method: "gme_support.api.receive_update.push_new_ticket_to_vendor",
            args: { ticket_name: frm.doc.name },
            freeze: true,
            freeze_message: "Linking ERP ticket...",
            callback: function (r) {
                if (r.message && r.message.status === "success" && r.message.gme_ticket_id) {
                    frm.doc.gme_ticket_id = r.message.gme_ticket_id;
                    frm.refresh_field("gme_ticket_id");
                    frm.reload_doc().then(() => resolve());
                    return;
                }
                resolve();
            },
            error: function () {
                resolve();
            }
        });
    });
}

function render_new_ticket_placeholder(frm) {
    const wrapper = frm.fields_dict.communication_html.$wrapper;
    wrapper.html(`
        <div style="border:1px solid var(--border-color); border-radius:12px; background:#fff; padding:24px; color:var(--text-muted);">
            Save the ticket first, then communication will be available.
        </div>
    `);
}

function bind_client_realtime(frm) {
    if (frm.__client_rt_bound) return;
    frm.__client_rt_bound = true;

    frappe.realtime.on("gme_customer_ticket_message_added", function (data) {
        if (data && data.ticket_name === frm.doc.name) {
            frm.reload_doc().then(() => render_client_chat(frm));
        }
    });
}

function render_client_chat(frm) {
    inject_client_chat_styles();

    const wrapper = frm.fields_dict.communication_html.$wrapper;
    wrapper.html(`
        <div class="gc-chat-wrap">
            <div class="gc-chat-head">
                <div>
                    <div class="gc-chat-title">Communication</div>
                    <div class="gc-chat-sub">Ticket conversation between raiser and solver</div>
                </div>
                <div style="display:flex; gap:8px;">
                    <button class="btn btn-sm btn-default" id="gc-chat-refresh">Refresh</button>
                </div>
            </div>

            <div id="gc-chat-body" class="gc-chat-body">
                <div class="gc-chat-empty">Loading messages...</div>
            </div>

            <div class="gc-chat-compose">
                <div class="gc-chat-editor-label">Type message</div>
                <div id="gc-chat-editor" class="gc-chat-editor" contenteditable="true"></div>
                <div class="gc-chat-compose-actions">
                    <button class="btn btn-sm btn-primary" id="gc-chat-send">Send Message</button>
                </div>
            </div>
        </div>
    `);

    wrapper.find("#gc-chat-refresh").off("click").on("click", function () {
        load_client_messages(frm);
    });

    wrapper.find("#gc-chat-send").off("click").on("click", function () {
        send_client_message(frm);
    });

    wrapper.find("#gc-chat-editor").off("keydown").on("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send_client_message(frm);
        }
    });

    load_client_messages(frm);
}

function get_client_editor_html(frm) {
    return frm.fields_dict.communication_html.$wrapper.find("#gc-chat-editor").html() || "";
}

function clear_client_editor(frm) {
    frm.fields_dict.communication_html.$wrapper.find("#gc-chat-editor").html("");
}

function has_real_content(html) {
    if (!html) return false;
    const text = $("<div>").html(html).text().replace(/\u00a0/g, " ").trim();
    const has_img = /<img[\s>]/i.test(html);
    const has_file = /<a[\s\S]*href=/i.test(html);
    return !!text || has_img || has_file;
}

function send_client_message(frm) {
    const message = get_client_editor_html(frm);

    if (!has_real_content(message)) {
        frappe.msgprint("Please enter a message.");
        return;
    }

    if (!frm.doc.gme_ticket_id) {
        frappe.msgprint("ERP ticket is not linked yet. Please save and refresh once.");
        return;
    }

    frappe.call({
        method: "gme_support.api.receive_update.add_ticket_message",
        args: {
            ticket_name: frm.doc.name,
            message: message
        },
        freeze: true,
        freeze_message: "Sending message...",
        callback: function (r) {
            if (r.message && r.message.status === "success") {
                clear_client_editor(frm);
                frm.reload_doc().then(() => {
                    load_client_messages(frm);
                    frappe.show_alert({message: "Message sent", indicator: "green"});
                });
            }
        }
    });
}

function load_client_messages(frm) {
    if (frm.is_new()) return;

    frappe.call({
        method: "gme_support.api.receive_update.get_ticket_messages",
        args: { ticket_name: frm.doc.name },
        callback: function (r) {
            const res = r.message || {};
            const my_side = res.instance_sender_type || "TR_C";
            const messages = res.messages || [];
            const body = frm.fields_dict.communication_html.$wrapper.find("#gc-chat-body");

            if (!messages.length) {
                body.html(`<div class="gc-chat-empty">No communication yet.</div>`);
                return;
            }

            const html = messages.map(row => {
                const mine = row.sender_type === my_side;
                return `
                    <div class="gc-msg-row ${mine ? "mine" : "other"}">
                        <div class="gc-msg-bubble">
                            <div class="gc-msg-meta">
                                <span class="gc-msg-name">${escape_client_html(row.sender_name || row.sender || "")}</span>
                                <span class="gc-msg-type">${escape_client_html(row.sender_type || "")}</span>
                            </div>
                            <div class="gc-msg-text">${row.message || ""}</div>
                            <div class="gc-msg-time">${format_client_dt(row.posted_on)}</div>
                        </div>
                    </div>`;
            }).join("");

            body.html(html);
            body.scrollTop(body[0].scrollHeight);
        }
    });
}

function format_client_dt(dt) {
    if (!dt) return "";
    try { return frappe.datetime.str_to_user(dt); }
    catch (e) { return dt; }
}

function escape_client_html(text) {
    return frappe.utils.escape_html(text == null ? "" : String(text));
}

function inject_client_chat_styles() {
    if (document.getElementById("gc-chat-style")) return;

    const style = document.createElement("style");
    style.id = "gc-chat-style";
    style.textContent = `
        .gc-chat-wrap{border:1px solid var(--border-color);border-radius:12px;background:var(--card-bg,#fff);overflow:hidden;margin-bottom:14px}
        .gc-chat-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border-color);background:var(--control-bg,#f8fafc)}
        .gc-chat-title{font-size:14px;font-weight:700}
        .gc-chat-sub{font-size:11px;color:var(--text-muted)}
        .gc-chat-body{max-height:420px;overflow-y:auto;padding:16px;background:#f8fafc}
        .gc-chat-empty{text-align:center;color:var(--text-muted);padding:24px}
        .gc-msg-row{display:flex;margin-bottom:12px}
        .gc-msg-row.mine{justify-content:flex-end}
        .gc-msg-row.other{justify-content:flex-start}
        .gc-msg-bubble{max-width:78%;padding:10px 12px;border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.05);word-break:break-word}
        .gc-msg-row.mine .gc-msg-bubble{background:#dbeafe;border-top-right-radius:4px}
        .gc-msg-row.other .gc-msg-bubble{background:#fff;border:1px solid #e5e7eb;border-top-left-radius:4px}
        .gc-msg-meta{display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:11px}
        .gc-msg-name{font-weight:700;color:#111827}
        .gc-msg-type{color:#6b7280;background:rgba(0,0,0,.06);border-radius:999px;padding:1px 6px}
        .gc-msg-text{font-size:13px;color:#111827}
        .gc-msg-text p:last-child{margin-bottom:0}
        .gc-msg-text img{max-width:220px;border-radius:8px;margin-top:6px}
        .gc-msg-time{font-size:10px;color:#6b7280;margin-top:6px;text-align:right}
        .gc-chat-compose{border-top:1px solid var(--border-color);background:#fff;padding:12px 14px}
        .gc-chat-editor-label{font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px}
        .gc-chat-editor{min-height:110px;border:1px solid var(--border-color);border-radius:10px;background:#fff;padding:10px 12px;font-size:13px;outline:none}
        .gc-chat-editor:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.12)}
        .gc-chat-compose-actions{display:flex;justify-content:flex-end;margin-top:10px}
    `;
    document.head.appendChild(style);
}