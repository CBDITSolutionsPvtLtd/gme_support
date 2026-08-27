frappe.pages["gme-support-portal"].on_page_load = function (wrapper) {
    gme_portal_render(wrapper);
};

frappe.pages["gme-support-portal"].on_page_show = function (wrapper) {
    if (!$(wrapper).find(".gp-wrap").length) {
        gme_portal_render(wrapper);
    }
};

function gme_portal_render(wrapper) {
    const page = frappe.ui.make_app_page({
        parent: wrapper,
        title: "GME Support Portal",
        single_column: true,
    });

    inject_styles();

    const STATE = {
        users: "__all__",
        period: "monthly",
        data: null,
        ticket_tab_built: false,
    };

    page.set_primary_action(__("New Ticket"), function () {
        frappe.new_doc("GME Helpdesk Ticket");
    });

    const $container = $(page.body);
    $container.html(`
        <div class="gp-wrap">
            <div class="gp-toolbar">
                <div class="gp-toolbar-left">
                    <div class="gp-field">
                        <label>User</label>
                        <select id="gp-user-filter" class="gp-select">
                            <option value="__all__">Loading...</option>
                        </select>
                    </div>

                    <div class="gp-field">
                        <label>Period</label>
                        <select id="gp-period-filter" class="gp-select">
                            <option value="daily">Daily</option>
                            <option value="weekly">Weekly</option>
                            <option value="monthly" selected>Monthly</option>
                            <option value="yearly">Yearly</option>
                        </select>
                    </div>

                    <button class="btn btn-primary btn-sm" id="gp-apply-filter">Apply</button>
                </div>

                <div class="gp-toolbar-right">
                    <button class="btn btn-default btn-sm" id="gp-refresh-btn">Refresh</button>
                </div>
            </div>

            <div class="gp-tabs">
                <button class="gp-tab active" data-tab="dashboard">Dashboard</button>
                <button class="gp-tab" data-tab="tickets">Tickets</button>
            </div>

            <div id="gp-dashboard-view">
                ${get_dashboard_skeleton()}
            </div>

            <div id="gp-ticket-view" style="display:none;"></div>
        </div>
    `);

    bind_tab_events();
    bind_toolbar_events();
    load_user_list();
    load_dashboard();

    function bind_tab_events() {
        $container.find(".gp-tab").off("click").on("click", function () {
            const tab = $(this).data("tab");
            $container.find(".gp-tab").removeClass("active");
            $(this).addClass("active");

            if (tab === "dashboard") {
                $("#gp-dashboard-view").show();
                $("#gp-ticket-view").hide();
            } else {
                $("#gp-dashboard-view").hide();
                $("#gp-ticket-view").show();
                if (!STATE.ticket_tab_built) {
                    STATE.ticket_tab_built = true;
                    build_ticket_tab();
                    fetch_tickets("All");
                }
            }
        });
    }

    function bind_toolbar_events() {
        $container.find("#gp-period-filter").on("change", function () {
            STATE.period = $(this).val();
        });

        $container.find("#gp-apply-filter").on("click", function () {
            STATE.users = $container.find("#gp-user-filter").val() || "__all__";
            load_dashboard();
            if (STATE.ticket_tab_built) {
                fetch_tickets(get_active_ticket_status());
            }
        });

        $container.find("#gp-refresh-btn").on("click", function () {
            load_dashboard();
            if (STATE.ticket_tab_built) {
                fetch_tickets(get_active_ticket_status());
            }
        });
    }

    function load_user_list() {
        frappe.call({
            method: "gme_support.gme_portal.page.gme_support_portal.gme_support_portal.get_user_list",
            callback: function (r) {
                const users = (r && r.message) || [];
                const $user = $container.find("#gp-user-filter");
                $user.empty();

                if (!users.length) {
                    $user.append(`<option value="__all__">All Users</option>`);
                } else {
                    users.forEach(function (u) {
                        $user.append(
                            `<option value="${escape_html(u.value)}">${escape_html(u.label)}</option>`
                        );
                    });
                }

                STATE.users = $user.val() || "__all__";
            },
        });
    }

    function load_dashboard() {
        $("#gp-dashboard-view").html(get_dashboard_skeleton());

        frappe.call({
            method: "gme_support.gme_portal.page.gme_support_portal.gme_support_portal.get_dashboard_data",
            args: {
                users: STATE.users,
                period: STATE.period,
            },
            callback: function (r) {
                if (!r || !r.message) {
                    $("#gp-dashboard-view").html(
                        `<div class="gp-empty">Unable to load dashboard data.</div>`
                    );
                    return;
                }

                STATE.data = r.message;
                render_dashboard(r.message);
            },
        });
    }

    function render_dashboard(data) {
        const status_map = data.status_map || {};
        const priority_map = data.priority_map || {};
        const is_manager = !!data.is_manager;

        const kpi_cards = [
            { label: "Total", value: data.total || 0, color: "#5e64ff", icon: "🎫" },
            { label: "Open", value: status_map.Open || 0, color: "#f59e0b", icon: "🔓" },
            { label: "Replied", value: status_map.Replied || 0, color: "#3b82f6", icon: "💬" },
            { label: "Resolved", value: status_map.Resolved || 0, color: "#10b981", icon: "✅" },
            { label: "Closed", value: status_map.Closed || 0, color: "#6b7280", icon: "🔒" },
            { label: "On Hold", value: status_map.Hold || status_map["On Hold"] || 0, color: "#8b5cf6", icon: "⏸" },
            { label: "Overdue", value: data.overdue_count || 0, color: "#ef4444", icon: "⚠️" },
            { label: "Avg Resolve", value: format_duration(data.avg_resolution || 0), color: "#0ea5e9", icon: "⏱" },
        ];

        $("#gp-dashboard-view").html(`
            <div class="gp-kpi-grid">
                ${kpi_cards.map(card => `
                    <div class="gp-kpi-card" style="--gp-card-color:${card.color}">
                        <div class="gp-kpi-icon">${card.icon}</div>
                        <div class="gp-kpi-value">${escape_html(String(card.value))}</div>
                        <div class="gp-kpi-label">${escape_html(card.label)}</div>
                    </div>
                `).join("")}
            </div>

            <div class="gp-grid gp-grid-3">
                <div class="gp-card">
                    <div class="gp-card-title">By Status</div>
                    <div id="gp-status-chart"></div>
                </div>

                <div class="gp-card">
                    <div class="gp-card-title">By Priority</div>
                    <div id="gp-priority-chart"></div>
                </div>

                <div class="gp-card">
                    <div class="gp-card-title">Top Keywords</div>
                    <div id="gp-keyword-chart"></div>
                </div>
            </div>

            <div class="gp-grid gp-grid-1">
                <div class="gp-card">
                    <div class="gp-card-title">Ticket Volume (${escape_html(capitalize(STATE.period))})</div>
                    <div id="gp-volume-chart"></div>
                </div>
            </div>

            <div class="gp-grid ${is_manager ? "gp-grid-2" : "gp-grid-1"}">
                ${is_manager ? `
                    <div class="gp-card">
                        <div class="gp-card-title">Top Users</div>
                        <div id="gp-users-chart"></div>
                    </div>
                ` : ""}
                <div class="gp-card">
                    <div class="gp-card-title">Status Summary</div>
                    <div id="gp-status-summary"></div>
                </div>
            </div>
        `);

        render_pie_with_legend("gp-status-chart", status_map, {
            Open: "#f59e0b",
            Replied: "#3b82f6",
            Resolved: "#10b981",
            Closed: "#6b7280",
            Hold: "#8b5cf6",
            "On Hold": "#8b5cf6",
        }, "Status");

        render_pie_with_legend("gp-priority-chart", priority_map, {
            Low: "#10b981",
            Medium: "#3b82f6",
            High: "#f59e0b",
            Urgent: "#ef4444",
        }, "Priority");

        render_hbar(
            "gp-keyword-chart",
            (data.word_counts || []).map(x => x[0]),
            (data.word_counts || []).map(x => x[1]),
            "#8b5cf6",
            "No keyword data yet"
        );

        render_status_summary("gp-status-summary", status_map, data.total || 0);

        if (is_manager) {
            render_hbar(
                "gp-users-chart",
                (data.top_users || []).map(u => u.label || u.user || ""),
                (data.top_users || []).map(u => u.count || 0),
                "#10b981",
                "No user data yet"
            );
        }

        render_curve_chart("gp-volume-chart", data);
    }

    function build_ticket_tab() {
        const s = (STATE.data && STATE.data.status_map) || {};
        const total = (STATE.data && STATE.data.total) || 0;

        const statuses = ["All", "Open", "Replied", "Resolved", "Closed", "Hold"];

        $("#gp-ticket-view").html(`
            <div class="gp-ticket-filters">
                ${statuses.map((st, idx) => {
                    const count = st === "All" ? total : (s[st] || 0);
                    return `
                        <button class="gp-filter-chip ${idx === 0 ? "active" : ""}" data-status="${escape_html(st)}">
                            ${escape_html(st)} <span>${count}</span>
                        </button>
                    `;
                }).join("")}
            </div>

            <div id="gp-ticket-list">
                <div class="gp-empty">Loading tickets...</div>
            </div>
        `);

        $("#gp-ticket-view .gp-filter-chip").off("click").on("click", function () {
            $("#gp-ticket-view .gp-filter-chip").removeClass("active");
            $(this).addClass("active");
            fetch_tickets($(this).data("status"));
        });
    }

    function get_active_ticket_status() {
        const $active = $("#gp-ticket-view .gp-filter-chip.active");
        return $active.length ? $active.data("status") : "All";
    }

    function fetch_tickets(status) {
        $("#gp-ticket-list").html(`<div class="gp-empty">Loading tickets...</div>`);

        frappe.call({
            method: "gme_support.gme_portal.page.gme_support_portal.gme_support_portal.get_tickets",
            args: {
                users: STATE.users,
                status: status,
                page: 1,
                page_length: 30,
            },
            callback: function (r) {
                const res = (r && r.message) || {};
                render_ticket_table(res.tickets || [], res.total || 0);
            },
        });
    }

    function render_ticket_table(rows, total) {
        if (!rows.length) {
            $("#gp-ticket-list").html(`<div class="gp-empty">No tickets found.</div>`);
            return;
        }

        $("#gp-ticket-list").html(`
            <div class="gp-ticket-meta">Showing ${rows.length} of ${total} tickets</div>
            <div class="gp-table-wrap">
                <table class="gp-table">
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Subject</th>
                            <th>Status</th>
                            <th>Priority</th>
                            <th>Raised By</th>
                            <th>Date</th>
                            <th>Resolved In</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(t => `
                            <tr class="gp-row-click" data-name="${escape_html(t.name)}">
                                <td><span class="gp-link">${escape_html(t.name || "")}</span></td>
                                <td title="${escape_html(t.subject || "")}">${escape_html(t.subject || "")}</td>
                                <td>${status_badge(t.status)}</td>
                                <td>${priority_badge(t.priority)}</td>
                                <td>${escape_html((t.raised_by || "").split("@")[0])}</td>
                                <td>${t.posting_date ? frappe.datetime.str_to_user(t.posting_date) : ""}</td>
                                <td>${t.resolution_time ? format_duration(parseInt(t.resolution_time, 10) || 0) : "—"}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        `);

        $("#gp-ticket-list .gp-row-click").off("click").on("click", function () {
            const name = $(this).data("name");
            if (name) {
                frappe.set_route("Form", "GME Helpdesk Ticket", name);
            }
        });
    }

    function render_pie_with_legend(container_id, data_map, color_map, label_name) {
        const labels = Object.keys(data_map || {}).filter(k => (data_map[k] || 0) > 0);
        const values = labels.map(k => data_map[k]);
        const total = values.reduce((a, b) => a + b, 0);

        if (!labels.length) {
            $("#" + container_id).html(`<div class="gp-empty">No data available</div>`);
            return;
        }

        const colors = labels.map(l => color_map[l] || "#94a3b8");

        const html = `
            <div class="gp-pie-wrap">
                <div id="${container_id}_chart" class="gp-chart-box"></div>
                <table class="gp-legend-table">
                    <thead>
                        <tr>
                            <th colspan="2">${escape_html(label_name)}</th>
                            <th>Count</th>
                            <th>%</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${labels.map((label, i) => `
                            <tr>
                                <td class="gp-dot-cell"><span class="gp-dot" style="background:${colors[i]}"></span></td>
                                <td>${escape_html(label)}</td>
                                <td class="text-right">${values[i]}</td>
                                <td class="text-right">${total ? Math.round((values[i] / total) * 100) : 0}%</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        `;

        $("#" + container_id).html(html);

        try {
            new frappe.Chart("#" + container_id + "_chart", {
                type: "donut",
                height: 180,
                colors: colors,
                data: {
                    labels: labels,
                    datasets: [{ values: values }],
                },
                tooltipOptions: {
                    formatTooltipY: d => `${d} tickets`,
                },
            });
        } catch (e) {
            // ignore chart failure, legend still shows data
        }
    }

    function render_hbar(container_id, labels, values, color, empty_text) {
        if (!labels.length) {
            $("#" + container_id).html(`<div class="gp-empty">${escape_html(empty_text || "No data")}</div>`);
            return;
        }

        const max = Math.max.apply(null, values.concat([1]));
        const html = labels.map((label, i) => `
            <div class="gp-hbar-row">
                <div class="gp-hbar-label" title="${escape_html(label)}">${escape_html(label)}</div>
                <div class="gp-hbar-track">
                    <div class="gp-hbar-fill" style="width:${Math.round((values[i] / max) * 100)}%; background:${color};"></div>
                </div>
                <div class="gp-hbar-value" style="color:${color};">${values[i]}</div>
            </div>
        `).join("");

        $("#" + container_id).html(html);
    }

    function render_status_summary(container_id, status_map, total) {
        const colors = {
            Open: "#f59e0b",
            Replied: "#3b82f6",
            Resolved: "#10b981",
            Closed: "#6b7280",
            Hold: "#8b5cf6",
            "On Hold": "#8b5cf6",
        };

        const rows = Object.keys(status_map || {}).map(key => {
            const val = status_map[key] || 0;
            const pct = total ? Math.round((val / total) * 100) : 0;
            const color = colors[key] || "#94a3b8";
            return `
                <div class="gp-hbar-row">
                    <div class="gp-hbar-label">
                        <span class="gp-dot" style="background:${color}"></span>${escape_html(key)}
                    </div>
                    <div class="gp-hbar-track">
                        <div class="gp-hbar-fill" style="width:${pct}%; background:${color};"></div>
                    </div>
                    <div class="gp-hbar-value" style="color:${color};">${val}</div>
                </div>
            `;
        }).join("");

        $("#" + container_id).html(rows || `<div class="gp-empty">No status data</div>`);
    }

    function render_curve_chart(container_id, data) {
        const keys = data.timeline_keys || [];
        const timeline_all = data.timeline_all || [];
        const user_series = data.user_series || [];
        const is_manager = !!data.is_manager;

        if (!keys.length) {
            $("#" + container_id).html(`<div class="gp-empty">No timeline data available</div>`);
            return;
        }

        const palette = [
            "#5e64ff", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
            "#0ea5e9", "#ec4899", "#14b8a6", "#f97316", "#84cc16"
        ];

        let datasets = [];
        if (is_manager && user_series.length > 1) {
            datasets = user_series.map((u, idx) => ({
                name: u.label || u.user || `User ${idx + 1}`,
                type: "line",
                values: u.values || [],
                color: palette[idx % palette.length],
            }));
        } else {
            datasets = [{
                name: "Tickets",
                type: "line",
                values: timeline_all,
                color: "#5e64ff",
            }];
        }

        $("#" + container_id).html(`
            <div class="gp-volume-legend">
                ${datasets.map(ds => `
                    <span class="gp-volume-legend-item">
                        <span class="gp-dot" style="background:${ds.color}"></span>
                        ${escape_html(ds.name)}
                    </span>
                `).join("")}
            </div>
            <div id="${container_id}_chart" class="gp-chart-box gp-chart-lg"></div>
        `);

        try {
            new frappe.Chart("#" + container_id + "_chart", {
                type: "axis-mixed",
                height: 280,
                colors: datasets.map(d => d.color),
                data: {
                    labels: keys,
                    datasets: datasets,
                },
                axisOptions: {
                    xAxisMode: "tick",
                    xIsSeries: true,
                },
                lineOptions: {
                    regionFill: 1,
                    hideDots: 0,
                },
            });
        } catch (e) {
            const simple = keys.map((k, i) => `
                <div class="gp-hbar-row">
                    <div class="gp-hbar-label">${escape_html(k)}</div>
                    <div class="gp-hbar-track">
                        <div class="gp-hbar-fill" style="width:${Math.min((timeline_all[i] || 0) * 10, 100)}%; background:#5e64ff;"></div>
                    </div>
                    <div class="gp-hbar-value"> ${timeline_all[i] || 0}</div>
                </div>
            `).join("");
            $("#" + container_id).append(`<div class="gp-fallback-list">${simple}</div>`);
        }
    }

    function status_badge(status) {
        const color_map = {
            Open: "orange",
            Replied: "blue",
            Resolved: "green",
            Closed: "gray",
            Hold: "purple",
            "On Hold": "purple",
        };
        return `<span class="indicator-pill ${color_map[status] || "gray"}">${escape_html(status || "")}</span>`;
    }

    function priority_badge(priority) {
        const color_map = {
            Low: "green",
            Medium: "blue",
            High: "orange",
            Urgent: "red",
        };
        return `<span class="indicator-pill ${color_map[priority] || "gray"}">${escape_html(priority || "")}</span>`;
    }

    function format_duration(seconds) {
        seconds = parseInt(seconds || 0, 10);
        if (!seconds) return "—";
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    function capitalize(s) {
        s = s || "";
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function escape_html(text) {
        return frappe.utils.escape_html(text == null ? "" : String(text));
    }

    function get_dashboard_skeleton() {
        return `
            <div class="gp-kpi-grid">
                ${Array(8).fill('<div class="gp-skeleton gp-skeleton-card"></div>').join("")}
            </div>
            <div class="gp-grid gp-grid-3">
                ${Array(3).fill('<div class="gp-skeleton gp-skeleton-panel"></div>').join("")}
            </div>
            <div class="gp-grid gp-grid-1">
                <div class="gp-skeleton gp-skeleton-panel gp-skeleton-xl"></div>
            </div>
        `;
    }

    function inject_styles() {
        if (document.getElementById("gp-portal-styles")) return;

        const style = document.createElement("style");
        style.id = "gp-portal-styles";
        style.textContent = `
            .gp-wrap {
                padding: 16px;
            }

            .gp-toolbar {
                display: flex;
                align-items: end;
                justify-content: space-between;
                gap: 12px;
                flex-wrap: wrap;
                background: var(--card-bg);
                border: 1px solid var(--border-color);
                border-radius: 12px;
                padding: 14px;
                margin-bottom: 16px;
            }

            .gp-toolbar-left,
            .gp-toolbar-right {
                display: flex;
                align-items: end;
                gap: 12px;
                flex-wrap: wrap;
            }

            .gp-field {
                display: flex;
                flex-direction: column;
                gap: 6px;
                min-width: 180px;
            }

            .gp-field label {
                font-size: 12px;
                font-weight: 600;
                color: var(--text-muted);
                margin: 0;
            }

            .gp-select {
                min-width: 180px;
                width: 100%;
                height: 34px;
                border: 1px solid var(--border-color);
                border-radius: 8px;
                padding: 6px 10px;
                background: var(--control-bg);
            }

            .gp-tabs {
                display: flex;
                gap: 8px;
                margin-bottom: 16px;
                border-bottom: 1px solid var(--border-color);
                padding-bottom: 10px;
                overflow-x: auto;
            }

            .gp-tab {
                border: none;
                background: transparent;
                padding: 8px 14px;
                border-radius: 8px;
                font-weight: 600;
                color: var(--text-muted);
                cursor: pointer;
                white-space: nowrap;
            }

            .gp-tab.active {
                background: var(--primary);
                color: #fff;
            }

            .gp-kpi-grid {
                display: grid;
                grid-template-columns: repeat(8, minmax(0, 1fr));
                gap: 12px;
                margin-bottom: 16px;
            }

            .gp-kpi-card {
                background: var(--card-bg);
                border: 1px solid var(--border-color);
                border-top: 3px solid var(--gp-card-color);
                border-radius: 12px;
                padding: 14px 12px;
            }

            .gp-kpi-icon {
                font-size: 18px;
                margin-bottom: 6px;
            }

            .gp-kpi-value {
                font-size: 28px;
                line-height: 1.1;
                font-weight: 700;
                color: var(--gp-card-color);
            }

            .gp-kpi-label {
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: .4px;
                color: var(--text-muted);
                margin-top: 4px;
            }

            .gp-grid {
                display: grid;
                gap: 16px;
                margin-bottom: 16px;
            }

            .gp-grid-3 {
                grid-template-columns: repeat(3, minmax(0, 1fr));
            }

            .gp-grid-2 {
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }

            .gp-grid-1 {
                grid-template-columns: 1fr;
            }

            .gp-card {
                background: var(--card-bg);
                border: 1px solid var(--border-color);
                border-radius: 12px;
                padding: 16px;
                overflow: hidden;
            }

            .gp-card-title {
                font-size: 13px;
                font-weight: 700;
                color: var(--heading-color);
                margin-bottom: 14px;
            }

            .gp-chart-box {
                min-height: 180px;
            }

            .gp-chart-lg {
                min-height: 280px;
            }

            .gp-pie-wrap {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }

            .gp-legend-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 12px;
            }

            .gp-legend-table th,
            .gp-legend-table td {
                padding: 6px 8px;
                border-bottom: 1px solid var(--border-color);
            }

            .gp-legend-table thead th {
                font-size: 11px;
                text-transform: uppercase;
                color: var(--text-muted);
            }

            .gp-dot-cell {
                width: 16px;
            }

            .gp-dot {
                display: inline-block;
                width: 10px;
                height: 10px;
                border-radius: 50%;
                vertical-align: middle;
            }

            .text-right {
                text-align: right;
            }

            .gp-hbar-row {
                display: grid;
                grid-template-columns: 120px 1fr 40px;
                gap: 8px;
                align-items: center;
                padding: 6px 0;
                border-bottom: 1px solid var(--border-color);
            }

            .gp-hbar-label {
                font-size: 12px;
                color: var(--text-color);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .gp-hbar-track {
                height: 12px;
                border-radius: 999px;
                background: var(--control-bg);
                overflow: hidden;
            }

            .gp-hbar-fill {
                height: 100%;
                border-radius: 999px;
            }

            .gp-hbar-value {
                text-align: right;
                font-size: 12px;
                font-weight: 700;
            }

            .gp-volume-legend {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                margin-bottom: 12px;
            }

            .gp-volume-legend-item {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                font-size: 12px;
                color: var(--text-muted);
            }

            .gp-ticket-filters {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                margin-bottom: 14px;
            }

            .gp-filter-chip {
                border: 1px solid var(--border-color);
                background: var(--card-bg);
                border-radius: 999px;
                padding: 6px 12px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
            }

            .gp-filter-chip span {
                background: var(--control-bg);
                border-radius: 999px;
                padding: 1px 6px;
                margin-left: 4px;
            }

            .gp-filter-chip.active {
                background: var(--primary);
                color: #fff;
                border-color: var(--primary);
            }

            .gp-filter-chip.active span {
                background: rgba(255,255,255,.2);
            }

            .gp-ticket-meta {
                font-size: 12px;
                color: var(--text-muted);
                margin-bottom: 10px;
            }

            .gp-table-wrap {
                overflow-x: auto;
            }

            .gp-table {
                width: 100%;
                border-collapse: collapse;
                min-width: 900px;
            }

            .gp-table th,
            .gp-table td {
                padding: 10px 12px;
                border-bottom: 1px solid var(--border-color);
                text-align: left;
                font-size: 12px;
                vertical-align: middle;
            }

            .gp-table th {
                background: var(--control-bg);
                color: var(--text-muted);
                text-transform: uppercase;
                font-size: 11px;
                letter-spacing: .4px;
            }

            .gp-row-click {
                cursor: pointer;
            }

            .gp-row-click:hover td {
                background: var(--control-bg);
            }

            .gp-link {
                color: var(--primary);
                font-weight: 700;
            }

            .gp-empty {
                padding: 24px;
                text-align: center;
                color: var(--text-muted);
            }

            .gp-skeleton {
                position: relative;
                overflow: hidden;
                background: var(--control-bg);
                border-radius: 12px;
            }

            .gp-skeleton::after {
                content: "";
                position: absolute;
                inset: 0;
                transform: translateX(-100%);
                background: linear-gradient(90deg, transparent, rgba(255,255,255,.4), transparent);
                animation: gp-shimmer 1.2s infinite;
            }

            .gp-skeleton-card {
                height: 96px;
            }

            .gp-skeleton-panel {
                height: 280px;
            }

            .gp-skeleton-xl {
                height: 320px;
            }

            @keyframes gp-shimmer {
                100% { transform: translateX(100%); }
            }

            @media (max-width: 1400px) {
                .gp-kpi-grid {
                    grid-template-columns: repeat(4, minmax(0, 1fr));
                }
            }

            @media (max-width: 992px) {
                .gp-grid-3,
                .gp-grid-2 {
                    grid-template-columns: 1fr;
                }
            }

            @media (max-width: 768px) {
                .gp-wrap {
                    padding: 12px;
                }

                .gp-kpi-grid {
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                }

                .gp-toolbar {
                    align-items: stretch;
                }

                .gp-toolbar-left,
                .gp-toolbar-right {
                    width: 100%;
                }

                .gp-field {
                    min-width: 100%;
                }

                .gp-select {
                    min-width: 100%;
                }

                .gp-hbar-row {
                    grid-template-columns: 90px 1fr 34px;
                }
            }
        `;
        document.head.appendChild(style);
    }
}