(() => {
      "use strict";

      const CONFIG = Object.freeze({
        workerProxy: "https://proxyefe.brendonadsrcc.workers.dev/",
        cacheDurationMs: 5 * 60 * 1000,
        auth: Object.freeze({
          temporaryUser: Object.freeze({
            nick: ".Brendon",
            role: "Desenvolvedor"
          })
        }),
        sheets: Object.freeze({
          oceanListApi: "https://script.google.com/macros/s/AKfycbylz0He8rir-m2iF4lBrhoWXve5qrxPt9rTc19lBVhdp58UmeWdPZDssQCXjfgTt4c53w/exec",
          membersId: "1Y09nybDM7GdOMpO03QZyoh0UP1-Or0CYyV_shKh84Oc",
          membersGid: "1532718941"
        }),
        forum: Object.freeze({
          origin: "https://brendonrcc.forumeiros.com",
          automaticDelayMs: 13000,
          bridgeTimeoutMs: 25000
        })
      });

      const CACHE_PREFIX = "OCEANLIST_CACHE_V1_";
      const ROLE_OPTIONS = Object.freeze([
        "Líder",
        "Vice-Líder",
        "Consultor(a)",
        "Ministro(a) da Administração",
        "Ministro(a) da Atualização",
        "Ministro(a) da Contabilidade",
        "Ministro(a) da Documentação",
        "Ministro(a) das Finanças",
        "Ministro(a) da Segurança",
        "Ministro(a) da Assistência",
        "Estagiário(a)",
        "Graduador(a)",
        "Mentor(a)",
        "Professor(a)"
      ]);
      const OCEAN_MONTHS = Object.freeze([
        "Jan",
        "Fev",
        "Mar",
        "Abr",
        "Mai",
        "Jun",
        "Jul",
        "Ago",
        "Set",
        "Out",
        "Nov",
        "Dez"
      ]);
      const DATE_HEADERS = Object.freeze([
        "ENTRADA",
        "DATA (PROMO/REB)",
        "INICIO",
        "TERMINO"
      ]);
      let currentUser = null;
      const appState = {
        headers: [],
        rows: [],
        settings: [],
        publishing: null,
        maxDataRow: 1,
        currentView: "members",
        search: "",
        editingMembers: false,
        removingMembers: false,
        addingMember: false,
        selectedMemberRows: new Set(),
        memberDrafts: new Map(),
        booleanColumns: new Set(),
        loading: false,
        savingMembers: false,
        organizingMembers: false,
        publishingBusy: false,
        editingSettingsRow: null,
        editingLayoutOwnerRow: null,
        loaded: false
      };

      function buildWorkerUrl(targetUrl) {
        const url = new URL(CONFIG.workerProxy);
        url.searchParams.set("url", targetUrl);
        return url.toString();
      }

      function spreadsheetExportUrl(id, gid, format = "tsv") {
        const url = new URL(`https://docs.google.com/spreadsheets/d/${id}/export`);
        url.searchParams.set("gid", gid);
        url.searchParams.set("format", format);
        return url.toString();
      }

      async function fetchViaWorker(targetUrl, options = {}) {
        const {
          forceRefresh = false,
          cacheDurationMs = CONFIG.cacheDurationMs,
          timeoutMs = 15000
        } = options;

        const cacheKey = `${CACHE_PREFIX}${targetUrl}`;

        if (!forceRefresh) {
          try {
            const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
            if (cached && Date.now() - cached.timestamp < cacheDurationMs) {
              return cached.data;
            }
          } catch {
            localStorage.removeItem(cacheKey);
          }
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(buildWorkerUrl(targetUrl), {
            signal: controller.signal
          });

          if (!response.ok) {
            throw new Error(`Worker respondeu com status ${response.status}.`);
          }

          const text = await response.text();
          if (!text.trim()) {
            throw new Error("O Worker retornou uma resposta vazia.");
          }

          try {
            localStorage.setItem(
              cacheKey,
              JSON.stringify({ timestamp: Date.now(), data: text })
            );
          } catch {
            // O cache é opcional e não deve impedir a consulta.
          }

          return text;
        } catch (error) {
          if (error.name === "AbortError") {
            throw new Error("A consulta excedeu o tempo limite.");
          }
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      }

      async function requestOceanList(action, payload = null) {
        const target = new URL(CONFIG.sheets.oceanListApi);
        const isWrite =
          action.startsWith("save") ||
          action === "removeData" ||
          action === "organizeData";
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 20000);
        const request = {
          method: isWrite ? "POST" : "GET",
          signal: controller.signal,
          cache: "no-store"
        };

        if (isWrite) {
          request.headers = { "Content-Type": "text/plain;charset=utf-8" };
          request.body = JSON.stringify({ action, ...(payload || {}) });
        } else {
          target.searchParams.set("action", action);
        }

        try {
          const response = await fetch(buildWorkerUrl(target.toString()), request);
          const text = await response.text();
          let result;

          try {
            result = JSON.parse(text);
          } catch {
            throw new Error("A API da OceanList retornou uma resposta inválida.");
          }

          if (!response.ok || !result.ok) {
            const message = result && result.error ? result.error : "Falha na API.";
            if (/não autorizado/i.test(message)) {
              throw new Error(
                "O Worker ainda precisa receber a chave segura da OceanList."
              );
            }
            throw new Error(message);
          }

          return result;
        } catch (error) {
          if (error.name === "AbortError") {
            throw new Error("A planilha demorou demais para responder.");
          }
          throw error;
        } finally {
          window.clearTimeout(timeout);
        }
      }

      function setWorkspaceState(state, label) {
        const element = document.getElementById("workspace-state");
        element.classList.remove("is-ready", "is-error");
        if (state) element.classList.add(`is-${state}`);
        element.textContent = label;
      }

      function setDataLoading(isLoading) {
        appState.loading = isLoading;
        document.getElementById("refresh-members").disabled =
          isLoading ||
          appState.editingMembers ||
          appState.removingMembers ||
          appState.addingMember;
        document.getElementById("refresh-settings").disabled = isLoading;
        document.getElementById("edit-layout").disabled =
          isLoading || !appState.settings.length;
        updateMemberEditControls();
      }

      function formatCount(value) {
        return Number(value || 0).toLocaleString("pt-BR");
      }

      function normalizeLookup(value) {
        return String(value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\./g, "")
          .trim()
          .toUpperCase();
      }

      function headerIndex(label) {
        const normalized = normalizeLookup(label);
        return appState.headers.findIndex(
          (header) => normalizeLookup(header) === normalized
        );
      }

      function memberFieldIndexes() {
        return {
          role: headerIndex("CARGO"),
          nickname: headerIndex("NICKNAME"),
          entry: headerIndex("ENTRADA"),
          promotion: headerIndex("DATA (PROMO/REB)")
        };
      }

      function isDateColumn(index) {
        const header = normalizeLookup(appState.headers[index]);
        return DATE_HEADERS.includes(header);
      }

      function roleRank(role) {
        const normalized = normalizeLookup(role);
        if (normalized === "LIDER") return 0;
        if (normalized === "VICE-LIDER") return 1;
        if (normalized === "CONSULTOR(A)") return 2;
        if (normalized.startsWith("MINISTRO(A)")) return 3;
        if (normalized === "ESTAGIARIO(A)") return 4;
        if (normalized === "GRADUADOR(A)") return 5;
        if (normalized === "MENTOR(A)") return 6;
        if (normalized === "PROFESSOR(A)") return 7;
        return 8;
      }

      function roleOptionIndex(role) {
        const normalized = normalizeLookup(role);
        const index = ROLE_OPTIONS.findIndex(
          (option) => normalizeLookup(option) === normalized
        );
        return index === -1 ? ROLE_OPTIONS.length : index;
      }

      function isConsultantRole(role) {
        return normalizeLookup(role) === "CONSULTOR(A)";
      }

      function parseOceanDate(value) {
        const raw = String(value || "").trim();
        if (!raw) return null;

        let year;
        let month;
        let day;
        let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);

        if (match) {
          year = Number(match[1]);
          month = Number(match[2]) - 1;
          day = Number(match[3]);
        } else {
          match = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
          if (match) {
            day = Number(match[1]);
            month = Number(match[2]) - 1;
            year = Number(match[3]);
          } else {
            match = raw.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ.]+)\s+(\d{4})$/);
            if (!match) return null;

            const aliases = {
              JAN: 0,
              FEV: 1,
              FEB: 1,
              MAR: 2,
              ABR: 3,
              APR: 3,
              MAI: 4,
              MAY: 4,
              JUN: 5,
              JUL: 6,
              AGO: 7,
              AUG: 7,
              SET: 8,
              SEP: 8,
              OUT: 9,
              OCT: 9,
              NOV: 10,
              DEZ: 11,
              DEC: 11
            };
            day = Number(match[1]);
            month = aliases[normalizeLookup(match[2]).slice(0, 3)];
            year = Number(match[3]);
          }
        }

        if (
          !Number.isInteger(year) ||
          !Number.isInteger(month) ||
          !Number.isInteger(day) ||
          month < 0 ||
          month > 11 ||
          day < 1 ||
          day > 31
        ) {
          return null;
        }

        const date = new Date(Date.UTC(year, month, day));
        if (
          date.getUTCFullYear() !== year ||
          date.getUTCMonth() !== month ||
          date.getUTCDate() !== day
        ) {
          return null;
        }

        return { year, month, day };
      }

      function formatOceanDate(value) {
        const parsed = parseOceanDate(value);
        if (!parsed) return String(value || "").trim();
        return `${String(parsed.day).padStart(2, "0")} ${
          OCEAN_MONTHS[parsed.month]
        } ${parsed.year}`;
      }

      function oceanDateToIso(value) {
        const parsed = parseOceanDate(value);
        if (!parsed) return "";
        return `${parsed.year}-${String(parsed.month + 1).padStart(
          2,
          "0"
        )}-${String(parsed.day).padStart(2, "0")}`;
      }

      function dateSortValue(value) {
        const parsed = parseOceanDate(value);
        return parsed
          ? Date.UTC(parsed.year, parsed.month, parsed.day)
          : Number.POSITIVE_INFINITY;
      }

      function normalizeConsultantValues(values) {
        const normalized = values.slice();
        const indexes = memberFieldIndexes();
        if (!isConsultantRole(normalized[indexes.role])) return normalized;

        normalized.forEach((_, index) => {
          if (index !== indexes.role && index !== indexes.nickname) {
            normalized[index] = "";
          }
        });
        return normalized;
      }

      function prepareMemberValues(values) {
        const normalized = normalizeConsultantValues(values);
        if (isConsultantRole(normalized[memberFieldIndexes().role])) {
          return normalized;
        }

        return normalized.map((value, index) =>
          isDateColumn(index) && parseOceanDate(value)
            ? formatOceanDate(value)
            : value
        );
      }

      function compareMemberRows(left, right) {
        const indexes = memberFieldIndexes();
        const leftRole = left.values[indexes.role];
        const rightRole = right.values[indexes.role];
        const rankDifference = roleRank(leftRole) - roleRank(rightRole);
        if (rankDifference) return rankDifference;

        const isProfessor = roleRank(leftRole) === 7;
        const dateIndex = isProfessor ? indexes.entry : indexes.promotion;
        const dateDifference =
          dateSortValue(left.values[dateIndex]) -
          dateSortValue(right.values[dateIndex]);
        if (dateDifference) return dateDifference;

        const roleDifference =
          roleOptionIndex(leftRole) - roleOptionIndex(rightRole);
        if (roleDifference) return roleDifference;

        return String(left.values[indexes.nickname] || "").localeCompare(
          String(right.values[indexes.nickname] || ""),
          "pt-BR",
          { sensitivity: "base" }
        );
      }

      function sortMembers() {
        appState.rows.sort(compareMemberRows);
      }

      function buildCompactMemberRows(members) {
        const nicknameIndex = memberFieldIndexes().nickname;
        const seenNicknames = new Map();
        const repeatedNicknames = new Set();
        const rows = members
          .slice()
          .sort(compareMemberRows)
          .map((member, index) => {
            const values = prepareMemberValues(member.values).map((value) =>
              String(value ?? "").trim()
            );
            const nickname = String(values[nicknameIndex] || "").trim();
            const nicknameKey = nickname.toLocaleLowerCase("pt-BR");

            if (nicknameKey) {
              if (seenNicknames.has(nicknameKey)) {
                repeatedNicknames.add(nickname);
              } else {
                seenNicknames.set(nicknameKey, true);
              }
            }

            return {
              row: index + 2,
              values
            };
          });

        if (repeatedNicknames.size) {
          throw new Error(
            `Nickname duplicado: ${Array.from(repeatedNicknames).join(
              ", "
            )}. Corrija ou remova a repetição antes de salvar.`
          );
        }

        return rows;
      }

      async function persistCompactMemberList(members) {
        const rows = buildCompactMemberRows(members);
        await requestOceanList("organizeData", { rows });

        appState.rows = rows.map((item) => ({
          row: item.row,
          source: Array(appState.headers.length).fill(""),
          saved: item.values.slice(),
          values: item.values.slice(),
          hasSaved: true
        }));
        appState.maxDataRow = rows.length + 1;
        sortMembers();
        return rows;
      }

      function updateSummary() {
        const edited = appState.rows.filter((row) => row.hasSaved).length;
        const roles = appState.settings.filter((item) => item.role).length;
        const vacancies = appState.settings.reduce((total, item) => {
          const value = Number(item.vacancies);
          return total + (Number.isFinite(value) ? value : 0);
        }, 0);

        document.getElementById("summary-members").textContent = formatCount(
          appState.rows.length
        );
        document.getElementById("summary-edited").textContent = formatCount(edited);
        document.getElementById("summary-roles").textContent = formatCount(roles);
        document.getElementById("summary-vacancies").textContent =
          formatCount(vacancies);
      }

      function filteredMembers() {
        const term = appState.search.trim().toLocaleLowerCase("pt-BR");
        if (!term) return appState.rows;

        return appState.rows.filter((row) =>
          memberDraft(row).some((value) =>
            String(value || "").toLocaleLowerCase("pt-BR").includes(term)
          )
        );
      }

      function booleanState(value) {
        const normalized = String(value ?? "").trim().toLowerCase();
        if (normalized === "true") return "true";
        if (normalized === "false") return "false";
        return "empty";
      }

      function detectBooleanColumns() {
        const columns = new Set();

        appState.headers.forEach((_, index) => {
          const header = String(appState.headers[index] || "")
            .trim()
            .toUpperCase();
          const populated = appState.rows
            .map((row) => booleanState(row.values[index]))
            .filter((state) => state !== "empty");

          if (
            ["G", "RL", "REB"].includes(header) ||
            (populated.length &&
              populated.every(
                (state) => state === "true" || state === "false"
              ))
          ) {
            columns.add(index);
          }
        });

        return columns;
      }

      function memberDraft(row) {
        return appState.memberDrafts.get(row.row) || row.values;
      }

      function isMemberRowDirty(row) {
        const draft = appState.memberDrafts.get(row.row);
        if (!draft) return false;

        return draft.some(
          (value, index) =>
            String(value ?? "").trim() !==
            String(row.values[index] ?? "").trim()
        );
      }

      function updateBooleanToggle(button, state, columnIndex) {
        const labels = {
          true: "Selecionado",
          false: "Desmarcado",
          empty: "Sem valor"
        };
        const header = appState.headers[columnIndex] || `Campo ${columnIndex + 1}`;

        button.dataset.state = state;
        button.textContent = "";
        button.setAttribute("aria-pressed", String(state === "true"));
        button.setAttribute("aria-label", `${header}: ${labels[state]}`);
        button.title =
          state === "empty"
            ? "Sem valor definido"
            : state === "true"
              ? "Selecionado"
              : "Desmarcado";
      }

      function createRoleSelect(value, options = {}) {
        const select = document.createElement("select");
        select.className = options.className || "table-select";
        if (options.id) select.id = options.id;
        if (options.index !== undefined) select.dataset.index = options.index;
        if (options.disabled) select.disabled = true;
        select.setAttribute(
          "aria-label",
          options.label || "Selecionar cargo"
        );

        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "Selecione";
        select.appendChild(blank);

        if (value && !ROLE_OPTIONS.includes(value)) {
          const current = document.createElement("option");
          current.value = value;
          current.textContent = value;
          select.appendChild(current);
        }

        ROLE_OPTIONS.forEach((role) => {
          const option = document.createElement("option");
          option.value = role;
          option.textContent = role;
          select.appendChild(option);
        });

        select.value = value || "";
        if (options.onChange) {
          select.addEventListener("change", () =>
            options.onChange(select.value, select)
          );
        }
        return select;
      }

      function createDateControl(value, options = {}) {
        const control = document.createElement("div");
        const formatted = formatOceanDate(value);
        control.className = `date-control${formatted ? "" : " is-empty"}`;
        control.dataset.value = formatted;

        const display = document.createElement("span");
        display.className = "date-control__value";
        display.textContent = formatted || "—";

        const calendar = document.createElement("span");
        calendar.className = "date-control__calendar";
        calendar.setAttribute("aria-hidden", "true");

        const input = document.createElement("input");
        input.className = "date-control__native";
        input.type = "date";
        input.value = oceanDateToIso(value);
        input.disabled = Boolean(options.disabled);
        input.setAttribute("aria-label", options.label || "Selecionar data");
        if (options.id) input.id = options.id;
        if (options.index !== undefined) input.dataset.index = options.index;

        input.addEventListener("change", () => {
          const nextValue = formatOceanDate(input.value);
          control.dataset.value = nextValue;
          display.textContent = nextValue || "—";
          control.classList.toggle("is-empty", !nextValue);
          if (options.onChange) options.onChange(nextValue, input);
        });

        control.append(display, calendar, input);
        return control;
      }

      function createMemberRoleSelect(value, row, columnIndex) {
        return createRoleSelect(value, {
          index: columnIndex,
          disabled: appState.savingMembers,
          label: `Cargo de ${row.values[1] || "membro"}`,
          onChange: (nextRole) => {
            const draft = memberDraft(row).slice();
            draft[columnIndex] = nextRole;
            appState.memberDrafts.set(
              row.row,
              normalizeConsultantValues(draft)
            );
            renderMembers();
          }
        });
      }

      function createMemberDateControl(value, row, columnIndex) {
        return createDateControl(value, {
          disabled: appState.savingMembers,
          label: `${
            appState.headers[columnIndex] || `Campo ${columnIndex + 1}`
          } de ${row.values[1] || "membro"}`,
          onChange: (nextValue) => {
            const draft = memberDraft(row).slice();
            draft[columnIndex] = nextValue;
            appState.memberDrafts.set(row.row, draft);
            const tableRow = document
              .querySelector(`[data-member-row="${row.row}"]`);
            if (tableRow) {
              tableRow.classList.toggle("is-dirty", isMemberRowDirty(row));
            }
          }
        });
      }

      function createBooleanToggle(value, row, columnIndex, editable) {
        const button = document.createElement("button");
        button.className = "boolean-toggle";
        button.type = "button";
        button.disabled = !editable || appState.savingMembers;
        updateBooleanToggle(button, booleanState(value), columnIndex);

        if (editable && !appState.savingMembers) {
          button.addEventListener("click", () => {
            const nextState =
              button.dataset.state === "true" ? "false" : "true";
            const draft = memberDraft(row).slice();
            draft[columnIndex] = nextState.toUpperCase();
            appState.memberDrafts.set(row.row, draft);
            updateBooleanToggle(button, nextState, columnIndex);
            button.closest("tr").classList.toggle(
              "is-dirty",
              isMemberRowDirty(row)
            );
          });
        }

        return button;
      }

      function createMemberInput(value, row, columnIndex) {
        const input = document.createElement("input");
        input.className = "table-input";
        input.type = "text";
        input.value = value ?? "";
        input.disabled = appState.savingMembers;
        input.setAttribute(
          "aria-label",
          `${appState.headers[columnIndex] || `Campo ${columnIndex + 1}`} · linha ${row.row}`
        );

        input.addEventListener("input", () => {
          const draft = memberDraft(row).slice();
          draft[columnIndex] = input.value;
          appState.memberDrafts.set(row.row, draft);
          input.closest("tr").classList.toggle(
            "is-dirty",
            isMemberRowDirty(row)
          );
        });

        return input;
      }

      function createMemberSelection(row) {
        const checkbox = document.createElement("input");
        const label =
          row.values[1] || row.values[0] || `registro da linha ${row.row}`;
        checkbox.className = "member-select";
        checkbox.type = "checkbox";
        checkbox.checked = appState.selectedMemberRows.has(row.row);
        checkbox.disabled = appState.savingMembers;
        checkbox.setAttribute("aria-label", `Selecionar ${label}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            appState.selectedMemberRows.add(row.row);
          } else {
            appState.selectedMemberRows.delete(row.row);
          }
          updateMemberEditControls();
          renderMembers();
        });
        return checkbox;
      }

      function renderMembers() {
        const table = document.getElementById("members-table");
        const head = document.getElementById("members-table-head");
        const body = document.getElementById("members-table-body");
        const tableState = document.getElementById("table-state");
        const resultLabel = document.getElementById("table-result");
        const rows = filteredMembers();

        head.replaceChildren();
        body.replaceChildren();

        if (appState.removingMembers) {
          const selectionHeader = document.createElement("th");
          selectionHeader.scope = "col";
          selectionHeader.className = "member-selection-cell";

          const selectAll = document.createElement("input");
          const selectedVisible = rows.filter((row) =>
            appState.selectedMemberRows.has(row.row)
          ).length;
          selectAll.className = "member-select";
          selectAll.type = "checkbox";
          selectAll.checked = Boolean(rows.length) && selectedVisible === rows.length;
          selectAll.indeterminate =
            selectedVisible > 0 && selectedVisible < rows.length;
          selectAll.disabled = appState.savingMembers || !rows.length;
          selectAll.setAttribute("aria-label", "Selecionar registros visíveis");
          selectAll.addEventListener("change", () => {
            rows.forEach((row) => {
              if (selectAll.checked) {
                appState.selectedMemberRows.add(row.row);
              } else {
                appState.selectedMemberRows.delete(row.row);
              }
            });
            updateMemberEditControls();
            renderMembers();
          });

          selectionHeader.appendChild(selectAll);
          head.appendChild(selectionHeader);
        }

        appState.headers.forEach((header, index) => {
          const cell = document.createElement("th");
          cell.scope = "col";
          cell.textContent = header || `Campo ${index + 1}`;
          cell.title = cell.textContent;
          if (appState.booleanColumns.has(index)) {
            cell.classList.add("is-boolean-column");
          }
          head.appendChild(cell);
        });

        const indexes = memberFieldIndexes();
        rows.forEach((row) => {
          const tableRow = document.createElement("tr");
          tableRow.dataset.memberRow = row.row;
          if (row.hasSaved) tableRow.classList.add("is-saved");
          if (isMemberRowDirty(row)) tableRow.classList.add("is-dirty");
          if (appState.selectedMemberRows.has(row.row)) {
            tableRow.classList.add("is-selected");
          }

          if (appState.removingMembers) {
            const selectionCell = document.createElement("td");
            selectionCell.className = "member-selection-cell";
            selectionCell.appendChild(createMemberSelection(row));
            tableRow.appendChild(selectionCell);
          }

          appState.headers.forEach((_, index) => {
            const cell = document.createElement("td");
            const value = memberDraft(row)[index] ?? "";
            const consultant = isConsultantRole(
              memberDraft(row)[indexes.role]
            );
            const consultantField =
              consultant &&
              index !== indexes.role &&
              index !== indexes.nickname;

            if (appState.booleanColumns.has(index)) {
              cell.classList.add("is-boolean-column");
            }

            if (consultantField) {
              const content = document.createElement("span");
              content.className = "table-cell is-empty";
              content.textContent = "—";
              content.title = "Não se aplica a Consultor(a)";
              cell.appendChild(content);
            } else if (appState.editingMembers) {
              cell.appendChild(
                appState.booleanColumns.has(index)
                  ? createBooleanToggle(value, row, index, true)
                  : index === indexes.role
                    ? createMemberRoleSelect(value, row, index)
                    : isDateColumn(index)
                      ? createMemberDateControl(value, row, index)
                      : createMemberInput(value, row, index)
              );
            } else if (booleanState(value) !== "empty") {
              cell.appendChild(createBooleanToggle(value, row, index, false));
            } else {
              const content = document.createElement("span");
              const displayValue = isDateColumn(index)
                ? formatOceanDate(value)
                : value;
              content.className = "table-cell";
              content.textContent = displayValue || "—";
              content.title = displayValue;
              if (!displayValue) content.classList.add("is-empty");
              cell.appendChild(content);
            }

            tableRow.appendChild(cell);
          });

          body.appendChild(tableRow);
        });

        const resultText = appState.search
          ? `${formatCount(rows.length)} de ${formatCount(appState.rows.length)} registros`
          : `${formatCount(rows.length)} registros`;
        if (appState.editingMembers) {
          resultLabel.textContent = `${resultText} · edição ativa`;
        } else if (appState.removingMembers) {
          resultLabel.textContent = `${resultText} · ${formatCount(
            appState.selectedMemberRows.size
          )} selecionado${
            appState.selectedMemberRows.size === 1 ? "" : "s"
          }`;
        } else {
          resultLabel.textContent = resultText;
        }

        if (!rows.length) {
          table.hidden = true;
          tableState.hidden = false;
          tableState.textContent = appState.search
            ? "Nenhum membro corresponde à busca."
            : "Nenhum registro foi encontrado em V:AE ou A:J.";
        } else {
          tableState.hidden = true;
          table.hidden = false;
        }
      }

      function updateMemberEditControls() {
        const editButton = document.getElementById("edit-members");
        const saveButton = document.getElementById("save-members-edit");
        const cancelEditButton = document.getElementById("cancel-members-edit");
        const addButton = document.getElementById("add-member");
        const publishingButton = document.getElementById("open-publishing");
        const organizeButton = document.getElementById("organize-members");
        const removeButton = document.getElementById("remove-members");
        const confirmRemoveButton = document.getElementById(
          "confirm-members-remove"
        );
        const cancelRemoveButton = document.getElementById(
          "cancel-members-remove"
        );
        const isEditing = appState.editingMembers;
        const isRemoving = appState.removingMembers;
        const isBusy =
          appState.loading ||
          appState.savingMembers ||
          appState.addingMember ||
          appState.publishingBusy;

        editButton.hidden = isEditing || isRemoving;
        addButton.hidden = isEditing || isRemoving;
        publishingButton.hidden = isEditing || isRemoving;
        organizeButton.hidden = isEditing || isRemoving;
        removeButton.hidden = isEditing || isRemoving;
        saveButton.hidden = !isEditing;
        cancelEditButton.hidden = !isEditing;
        confirmRemoveButton.hidden = !isRemoving;
        cancelRemoveButton.hidden = !isRemoving;

        editButton.disabled = isBusy || !appState.loaded;
        addButton.disabled = isBusy || !appState.loaded;
        publishingButton.disabled =
          isBusy || !appState.loaded || !hasPublishingData();
        organizeButton.disabled =
          isBusy || !appState.loaded || !appState.rows.length;
        removeButton.disabled =
          isBusy || !appState.loaded || !appState.rows.length;
        saveButton.disabled = appState.savingMembers;
        cancelEditButton.disabled = appState.savingMembers;
        confirmRemoveButton.disabled =
          appState.savingMembers || !appState.selectedMemberRows.size;
        cancelRemoveButton.disabled = appState.savingMembers;
        organizeButton.textContent = appState.organizingMembers
          ? "Organizando…"
          : "Organizar lista";
        saveButton.textContent = appState.savingMembers
          ? "Salvando…"
          : "Salvar alterações";
        confirmRemoveButton.textContent = appState.savingMembers
          ? "Removendo…"
          : appState.selectedMemberRows.size
            ? `Remover ${formatCount(appState.selectedMemberRows.size)}`
            : "Remover selecionados";

        document.getElementById("refresh-members").disabled =
          isBusy || isEditing || isRemoving;
      }

      function beginMemberEditing() {
        if (
          !appState.loaded ||
          appState.editingMembers ||
          appState.removingMembers ||
          appState.addingMember
        ) {
          return;
        }

        appState.memberDrafts = new Map(
          appState.rows.map((row) => [row.row, row.values.slice()])
        );
        appState.booleanColumns = detectBooleanColumns();
        appState.editingMembers = true;
        setWorkspaceState("", "Editando");
        updateMemberEditControls();
        renderMembers();
      }

      function cancelMemberEditing() {
        if (appState.savingMembers) return;

        appState.editingMembers = false;
        appState.memberDrafts.clear();
        setWorkspaceState("ready", "Sincronizado");
        updateMemberEditControls();
        renderMembers();
      }

      async function organizeMemberList() {
        if (
          !appState.loaded ||
          !appState.rows.length ||
          appState.loading ||
          appState.savingMembers ||
          appState.editingMembers ||
          appState.removingMembers ||
          appState.addingMember
        ) {
          return;
        }

        appState.savingMembers = true;
        appState.organizingMembers = true;
        setWorkspaceState("", "Organizando");
        updateMemberEditControls();
        renderMembers();

        try {
          const rows = await persistCompactMemberList(appState.rows);
          appState.selectedMemberRows.clear();
          updateSummary();
          updateDataTimestamp();
          setWorkspaceState("ready", "Sincronizado");
          showToast(
            `${formatCount(rows.length)} registro${
              rows.length === 1 ? "" : "s"
            } organizado${rows.length === 1 ? "" : "s"} e atualizado${
              rows.length === 1 ? "" : "s"
            } em A:J.`,
            "success"
          );
        } catch (error) {
          setWorkspaceState("error", "Falha ao organizar");
          showToast(error.message, "error");
        } finally {
          appState.savingMembers = false;
          appState.organizingMembers = false;
          updateMemberEditControls();
          renderMembers();
        }
      }

      async function saveMemberList() {
        if (!appState.editingMembers || appState.savingMembers) return;

        const changedRows = appState.rows
          .filter(isMemberRowDirty)
          .map((row) => ({
            row: row.row,
            values: prepareMemberValues(memberDraft(row)).map((value) =>
              String(value ?? "").trim()
            )
          }));

        if (!changedRows.length) {
          cancelMemberEditing();
          showToast("Nenhuma alteração para salvar.", "info");
          return;
        }

        const changedByRow = new Map(
          changedRows.map((item) => [item.row, item.values])
        );
        const nextMembers = appState.rows.map((row) => ({
          ...row,
          values: changedByRow.get(row.row) || row.values
        }));

        appState.savingMembers = true;
        setWorkspaceState("", "Salvando");
        updateMemberEditControls();
        renderMembers();

        try {
          await persistCompactMemberList(nextMembers);
          appState.editingMembers = false;
          appState.memberDrafts.clear();
          updateSummary();
          updateDataTimestamp();
          setWorkspaceState("ready", "Sincronizado");
          showToast(
            `${formatCount(changedRows.length)} registro${
              changedRows.length === 1 ? "" : "s"
            } salvo${changedRows.length === 1 ? "" : "s"} com segurança em A:J.`,
            "success"
          );
        } catch (error) {
          setWorkspaceState("error", "Falha ao salvar");
          showToast(error.message, "error");
        } finally {
          appState.savingMembers = false;
          updateMemberEditControls();
          renderMembers();
        }
      }

      function createAddBooleanField(label, index) {
        const wrapper = document.createElement("div");
        wrapper.className = "form-field";
        wrapper.dataset.addMemberIndex = String(index);

        const buttonId = `add-member-boolean-${index}`;
        const fieldLabel = document.createElement("label");
        fieldLabel.htmlFor = buttonId;
        fieldLabel.textContent = label;

        const button = document.createElement("button");
        button.id = buttonId;
        button.className = "boolean-toggle";
        button.type = "button";
        button.dataset.addBooleanIndex = String(index);
        updateBooleanToggle(button, "empty", index);
        button.addEventListener("click", () => {
          const nextState =
            button.dataset.state === "true" ? "false" : "true";
          updateBooleanToggle(button, nextState, index);
        });

        wrapper.append(fieldLabel, button);
        return wrapper;
      }

      function createAddRoleField(label, index) {
        const wrapper = document.createElement("div");
        wrapper.className = "form-field";
        wrapper.dataset.addMemberIndex = String(index);

        const fieldLabel = document.createElement("label");
        fieldLabel.htmlFor = "add-member-role";
        fieldLabel.textContent = label;

        const select = createRoleSelect("", {
          id: "add-member-role",
          index,
          className: "form-select",
          label,
          onChange: updateAddMemberFieldVisibility
        });
        wrapper.append(fieldLabel, select);
        return wrapper;
      }

      function createAddDateField(label, index) {
        const wrapper = document.createElement("div");
        wrapper.className = "form-field";
        wrapper.dataset.addMemberIndex = String(index);

        const inputId = `add-member-date-${index}`;
        const fieldLabel = document.createElement("label");
        fieldLabel.htmlFor = inputId;
        fieldLabel.textContent = label;

        wrapper.append(
          fieldLabel,
          createDateControl("", { id: inputId, index, label })
        );
        return wrapper;
      }

      function updateAddMemberFieldVisibility() {
        const role = document.getElementById("add-member-role");
        if (!role) return;
        const indexes = memberFieldIndexes();
        const consultant = isConsultantRole(role.value);

        document
          .querySelectorAll("[data-add-member-index]")
          .forEach((field) => {
            const index = Number(field.dataset.addMemberIndex);
            field.hidden =
              consultant &&
              index !== indexes.role &&
              index !== indexes.nickname;
          });

        const booleanGroup = document.getElementById(
          "add-member-boolean-group"
        );
        if (booleanGroup) booleanGroup.hidden = consultant;
      }

      function openAddMemberEditor() {
        if (
          !appState.loaded ||
          appState.editingMembers ||
          appState.removingMembers ||
          appState.addingMember
        ) {
          return;
        }

        appState.addingMember = true;
        appState.booleanColumns = detectBooleanColumns();
        const fields = document.getElementById("add-member-fields");
        fields.replaceChildren();
        const indexes = memberFieldIndexes();
        const booleanGroup = document.createElement("div");
        booleanGroup.id = "add-member-boolean-group";
        booleanGroup.className = "add-member-boolean-group";

        appState.headers.forEach((header, index) => {
          const label = header || `Campo ${index + 1}`;
          let field;

          if (index === indexes.role) {
            field = createAddRoleField(label, index);
          } else if (appState.booleanColumns.has(index)) {
            field = createAddBooleanField(label, index);
          } else if (isDateColumn(index)) {
            field = createAddDateField(label, index);
          } else {
            field = createFormField(label, "", index, {
              id: `add-member-field-${index}`,
              placeholder: "Preencha este campo"
            });
            field.dataset.addMemberIndex = String(index);
          }

          if (appState.booleanColumns.has(index)) {
            booleanGroup.appendChild(field);
          } else {
            fields.appendChild(field);
          }
        });

        if (booleanGroup.childElementCount) {
          fields.appendChild(booleanGroup);
        }

        updateAddMemberFieldVisibility();
        updateMemberEditControls();
        document.getElementById("add-member-editor").showModal();
      }

      function closeAddMemberEditor() {
        if (appState.savingMembers) return;
        appState.addingMember = false;
        document.getElementById("add-member-editor").close();
        updateMemberEditControls();
      }

      async function saveNewMember(event) {
        event.preventDefault();
        if (!appState.addingMember || appState.savingMembers) return;

        const indexes = memberFieldIndexes();
        const values = prepareMemberValues(
          appState.headers.map((_, index) => {
            if (index === indexes.role) {
              return document.getElementById("add-member-role").value;
            }
            if (appState.booleanColumns.has(index)) {
              const button = document.getElementById(
                `add-member-boolean-${index}`
              );
              return button.dataset.state === "empty"
                ? ""
                : button.dataset.state.toUpperCase();
            }
            if (isDateColumn(index)) {
              return document
                .getElementById(`add-member-date-${index}`)
                .closest(".date-control").dataset.value;
            }

            return document
              .getElementById(`add-member-field-${index}`)
              .value.trim();
          })
        );

        if (!values.some(Boolean)) {
          showToast("Preencha ao menos um campo para adicionar.", "warning");
          return;
        }

        const newRowNumber = Math.max(appState.maxDataRow, 1) + 1;
        const nextMembers = appState.rows.concat({
          row: newRowNumber,
          source: Array(appState.headers.length).fill(""),
          saved: [],
          values,
          hasSaved: false
        });
        const button = document.getElementById("save-new-member");
        appState.savingMembers = true;
        button.disabled = true;
        button.textContent = "Adicionando…";
        updateMemberEditControls();

        try {
          await persistCompactMemberList(nextMembers);
          appState.addingMember = false;
          document.getElementById("add-member-editor").close();
          renderMembers();
          updateSummary();
          updateDataTimestamp();
          setWorkspaceState("ready", "Sincronizado");
          showToast("Novo membro adicionado com segurança em A:J.", "success");
        } catch (error) {
          showToast(error.message, "error");
        } finally {
          appState.savingMembers = false;
          button.disabled = false;
          button.textContent = "Adicionar em A:J";
          updateMemberEditControls();
        }
      }

      function beginMemberRemoval() {
        if (
          !appState.loaded ||
          !appState.rows.length ||
          appState.editingMembers ||
          appState.removingMembers ||
          appState.addingMember
        ) {
          return;
        }

        appState.removingMembers = true;
        appState.selectedMemberRows.clear();
        setWorkspaceState("", "Selecionando");
        updateMemberEditControls();
        renderMembers();
      }

      function cancelMemberRemoval() {
        if (appState.savingMembers) return;
        appState.removingMembers = false;
        appState.selectedMemberRows.clear();
        setWorkspaceState("ready", "Sincronizado");
        updateMemberEditControls();
        renderMembers();
      }

      async function confirmMemberRemoval() {
        if (
          !appState.removingMembers ||
          appState.savingMembers ||
          !appState.selectedMemberRows.size
        ) {
          return;
        }

        const selected = new Set(appState.selectedMemberRows);
        const rows = Array.from(selected);
        const remainingMembers = appState.rows.filter(
          (row) => !selected.has(row.row)
        );

        appState.savingMembers = true;
        setWorkspaceState("", "Removendo");
        updateMemberEditControls();
        renderMembers();

        try {
          await persistCompactMemberList(remainingMembers);
          appState.removingMembers = false;
          appState.selectedMemberRows.clear();
          updateSummary();
          updateDataTimestamp();
          setWorkspaceState("ready", "Sincronizado");
          showToast(
            `${formatCount(rows.length)} membro${
              rows.length === 1 ? "" : "s"
            } removido${rows.length === 1 ? "" : "s"} da OceanList.`,
            "success"
          );
        } catch (error) {
          setWorkspaceState("error", "Falha ao remover");
          showToast(error.message, "error");
        } finally {
          appState.savingMembers = false;
          updateMemberEditControls();
          renderMembers();
        }
      }

      function renderSettings() {
        const list = document.getElementById("role-list");
        list.replaceChildren();
        const roles = appState.settings.filter(
          (item) =>
            String(item.role || "").trim() ||
            String(item.vacancies ?? "").trim()
        );
        roles.sort((left, right) => {
          const rankDifference = roleRank(left.role) - roleRank(right.role);
          if (rankDifference) return rankDifference;
          return roleOptionIndex(left.role) - roleOptionIndex(right.role);
        });

        if (!roles.length) {
          const empty = document.createElement("p");
          empty.className = "role-list__empty";
          empty.textContent = "Nenhum cargo preenchido em N:O.";
          list.appendChild(empty);
        } else {
          roles.forEach((item) => {
            const card = document.createElement("article");
            card.className = "role-card";

            const top = document.createElement("div");
            top.className = "role-card__top";

            const name = document.createElement("strong");
            name.className = "role-card__name";
            name.textContent = item.role || `Cargo da linha ${item.row}`;
            name.title = name.textContent;

            const meta = document.createElement("div");
            meta.className = "role-card__meta";

            const vacancies = document.createElement("span");
            vacancies.className = "role-card__vacancies";
            vacancies.textContent =
              item.vacancies === "" || item.vacancies === null
                ? "Vagas não definidas"
                : `${formatCount(item.vacancies)} vaga${
                    Number(item.vacancies) === 1 ? "" : "s"
                  }`;

            const editButton = document.createElement("button");
            editButton.className = "text-button";
            editButton.type = "button";
            editButton.textContent = "Editar";
            editButton.addEventListener("click", () =>
              openSettingsEditor(item.row)
            );

            top.append(name);
            meta.append(vacancies, editButton);
            card.append(top, meta);
            list.appendChild(card);
          });
        }

        renderLayoutResources();
      }

      function getLayoutOwner() {
        return (
          appState.settings.find(
            (item) =>
              String(item.banner || "").trim() ||
              (item.links || []).some((link) => String(link || "").trim())
          ) ||
          appState.settings[0] ||
          null
        );
      }

      function displayHostname(value) {
        if (!value) return "Ainda não configurado";
        try {
          return new URL(value).hostname;
        } catch {
          return value;
        }
      }

      function createLayoutResource(label, value, meta) {
        const card = document.createElement("article");
        card.className = "layout-resource";

        const labelElement = document.createElement("span");
        labelElement.className = "layout-resource__label";
        labelElement.textContent = label;

        const valueElement = document.createElement("strong");
        valueElement.className = "layout-resource__value";
        valueElement.textContent = value;
        valueElement.title = value;

        const metaElement = document.createElement("span");
        metaElement.className = "layout-resource__meta";
        metaElement.textContent = meta;
        metaElement.title = meta;

        card.append(labelElement, valueElement, metaElement);
        return card;
      }

      function renderLayoutResources() {
        const container = document.getElementById("layout-resources");
        const editButton = document.getElementById("edit-layout");
        const owner = getLayoutOwner();
        container.replaceChildren();
        editButton.disabled = appState.loading || !owner;

        if (!owner) {
          const empty = document.createElement("p");
          empty.className = "layout-resources__empty";
          empty.textContent = "Nenhum espaço de configuração disponível em L:T.";
          container.appendChild(empty);
          return;
        }

        const bannerCard = createLayoutResource(
          "Banner",
          owner.banner ? "Banner configurado" : "Sem banner",
          displayHostname(owner.banner)
        );

        const colors = appState.settings
          .map((item) => String(item.color || "").trim())
          .filter(Boolean);
        const paletteCard = document.createElement("article");
        paletteCard.className = "layout-resource";
        const paletteLabel = document.createElement("span");
        paletteLabel.className = "layout-resource__label";
        paletteLabel.textContent = "Paleta";
        const palette = document.createElement("div");
        palette.className = "layout-palette";

        if (colors.length) {
          colors.forEach((color) => {
            const swatch = document.createElement("span");
            swatch.className = "layout-palette__swatch";
            swatch.title = color;
            if (/^#[0-9a-f]{6}$/i.test(color)) {
              swatch.style.setProperty("--layout-color", color);
            }
            palette.appendChild(swatch);
          });
        } else {
          const value = document.createElement("strong");
          value.className = "layout-resource__value";
          value.textContent = "Sem cores";
          palette.appendChild(value);
        }

        const paletteMeta = document.createElement("span");
        paletteMeta.className = "layout-resource__meta";
        paletteMeta.textContent = colors.length
          ? `${formatCount(colors.length)} cor${colors.length === 1 ? "" : "es"} em M:M`
          : "A paleta será usada na futura composição do BBCode";
        paletteCard.append(paletteLabel, palette, paletteMeta);

        const links = (owner.links || []).filter((link) =>
          String(link || "").trim()
        );
        const topicIds = (owner.topicIds || []).map((topicId) =>
          String(topicId || "").trim()
        );
        const topicsCard = createLayoutResource(
          "Tópicos",
          topicIds.filter(Boolean).length
            ? `${formatCount(topicIds.filter(Boolean).length)} IDs configurados`
            : "Sem IDs",
          `Listagem: ${topicIds[0] || "—"} · Consulta: ${
            topicIds[1] || "—"
          } · Backup: ${topicIds[2] || "—"}`
        );
        const linksCard = createLayoutResource(
          "Links importantes",
          links.length
            ? `${formatCount(links.length)} link${links.length === 1 ? "" : "s"}`
            : "Sem links",
          links.length
            ? links.map(displayHostname).join(" · ")
            : "Espaços disponíveis em S:T"
        );

        container.append(bannerCard, paletteCard, topicsCard, linksCard);
      }

      function updateDataTimestamp(isoDate) {
        const target = document.getElementById("data-updated");
        const date = isoDate ? new Date(isoDate) : new Date();
        target.textContent = `Sincronizado às ${date.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit"
        })}`;
      }

      function hasPublishingData() {
        const publishing = appState.publishing;
        return Boolean(
          publishing &&
            String(publishing.listingTopicId || "").trim() &&
            String(publishing.consultationTopicId || "").trim() &&
            String(publishing.backupTopicId || "").trim() &&
            String(publishing.listingBbcode || "").trim() &&
            String(publishing.consultationBbcode || "").trim()
        );
      }

      function requireTopicId(value, label) {
        const topicId = String(value || "").trim();
        if (!/^\d+$/.test(topicId)) {
          throw new Error(`${label} deve conter somente o ID numérico do tópico.`);
        }
        return topicId;
      }

      function currentOceanDate() {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Fortaleza",
          day: "2-digit",
          month: "2-digit",
          year: "numeric"
        })
          .formatToParts(new Date())
          .reduce((result, part) => {
            result[part.type] = part.value;
            return result;
          }, {});

        return `${parts.day} ${OCEAN_MONTHS[Number(parts.month) - 1]} ${
          parts.year
        }`;
      }

      function publishingBackupBbcode() {
        const consultation = String(
          (appState.publishing && appState.publishing.consultationBbcode) || ""
        );
        return `[spoiler="${currentOceanDate()}"][code]${consultation}[/code][/spoiler]`;
      }

      function publishingText(kind) {
        if (!appState.publishing) return "";
        if (kind === "listing") return appState.publishing.listingBbcode || "";
        if (kind === "consultation") {
          return appState.publishing.consultationBbcode || "";
        }
        if (kind === "backup") return publishingBackupBbcode();
        return "";
      }

      function renderPublishingDialog() {
        document.getElementById("publish-listing-code").value =
          publishingText("listing");
        document.getElementById("publish-consultation-code").value =
          publishingText("consultation");
        document.getElementById("publish-backup-code").value =
          publishingText("backup");

        document.querySelectorAll("[data-publish-action]").forEach((button) => {
          button.disabled = appState.publishingBusy || !hasPublishingData();
        });
      }

      function setPublishingMode(mode) {
        const manual = mode !== "automatic";
        const manualButton = document.getElementById("publish-mode-manual");
        const automaticButton = document.getElementById("publish-mode-auto");

        manualButton.classList.toggle("is-active", manual);
        automaticButton.classList.toggle("is-active", !manual);
        manualButton.setAttribute("aria-selected", String(manual));
        automaticButton.setAttribute("aria-selected", String(!manual));
        document.getElementById("publish-manual-panel").hidden = !manual;
        document.getElementById("publish-auto-panel").hidden = manual;
      }

      function openPublishingDialog() {
        if (!hasPublishingData()) {
          showToast(
            "Preencha P2:R2 e AG2:AH2 e publique a versão atualizada da API.",
            "warning"
          );
          return;
        }

        setPublishingMode("manual");
        document.getElementById("publish-status").textContent =
          "Selecione uma ação para iniciar.";
        renderPublishingDialog();
        document.getElementById("publishing-dialog").showModal();
      }

      function closePublishingDialog() {
        if (appState.publishingBusy) {
          showToast("Aguarde a publicação em andamento.", "warning");
          return;
        }
        document.getElementById("publishing-dialog").close();
      }

      async function copyPublishingText(kind) {
        const text = publishingText(kind);
        if (!text) {
          showToast("Não há BBCode disponível para copiar.", "warning");
          return;
        }

        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
          } else {
            const field = document.getElementById(`publish-${kind}-code`);
            field.focus();
            field.select();
            if (!document.execCommand("copy")) {
              throw new Error("A cópia automática não está disponível.");
            }
          }
          showToast("BBCode copiado.", "success");
        } catch (error) {
          showToast(error.message, "error");
        }
      }

      function forumTopicUrl(topicId) {
        return `${CONFIG.forum.origin}/t${topicId}-`;
      }

      function parseForumDocument(html) {
        return new DOMParser().parseFromString(html, "text/html");
      }

      function forumLoginRequired(documentNode, responseUrl) {
        return (
          /\/login(?:\?|$)/i.test(responseUrl || "") ||
          Boolean(
            documentNode.querySelector(
              'form[action*="/login"] input[name="username"]'
            )
          )
        );
      }

      async function fetchForumDocument(url) {
        const response = await fetch(url, {
          credentials: "include",
          redirect: "follow",
          cache: "no-store"
        });
        const html = await response.text();
        const documentNode = parseForumDocument(html);

        if (!response.ok) {
          throw new Error(`O fórum respondeu com status ${response.status}.`);
        }
        if (forumLoginRequired(documentNode, response.url)) {
          throw new Error("Entre no fórum antes de usar a postagem automática.");
        }

        return {
          document: documentNode,
          url: response.url || url
        };
      }

      function findForumPostingForm(documentNode) {
        return Array.from(documentNode.forms).find((form) =>
          form.querySelector(
            'textarea[name="message"], textarea#text_editor_textarea, textarea'
          )
        );
      }

      function applyForumSubmissionOptions(body, form, options = {}) {
        if (options.clearEditReason) {
          body.delete("edit_reason");
        }

        if (options.disableHtml) {
          const disableHtmlControl = form.querySelector(
            'input[name="disable_html"]'
          );
          body.set(
            disableHtmlControl?.name || "disable_html",
            disableHtmlControl?.value || "1"
          );
        }
      }

      async function submitForumPostingForm(formUrl, bbcode, options = {}) {
        const page = await fetchForumDocument(formUrl);
        const form = findForumPostingForm(page.document);
        if (!form) {
          throw new Error(
            "O formulário de postagem não foi encontrado. Verifique sua permissão."
          );
        }

        const textarea = form.querySelector(
          'textarea[name="message"], textarea#text_editor_textarea, textarea'
        );
        const body = new FormData(form);
        body.set(textarea.name || "message", bbcode);
        body.delete("preview");
        body.set("post", "Enviar");
        applyForumSubmissionOptions(body, form, options);

        const action = new URL(
          form.getAttribute("action") || "/post",
          CONFIG.forum.origin
        );
        if (action.origin !== CONFIG.forum.origin) {
          throw new Error("O formulário do fórum apontou para uma origem inesperada.");
        }
        const response = await fetch(action, {
          method: "POST",
          credentials: "include",
          redirect: "follow",
          body
        });
        const html = await response.text();
        const resultDocument = parseForumDocument(html);

        if (!response.ok) {
          throw new Error(`O fórum recusou o envio com status ${response.status}.`);
        }
        if (forumLoginRequired(resultDocument, response.url)) {
          throw new Error("Sua sessão do fórum expirou. Entre novamente.");
        }
        if (
          /\/post(?:\?|$)/i.test(response.url || "") &&
          findForumPostingForm(resultDocument)
        ) {
          const error =
            resultDocument.querySelector(
              ".message-die, .error, .panel .error, .block-error"
            )?.textContent || "O fórum não confirmou a publicação.";
          throw new Error(error.trim());
        }

        return response.url;
      }

      async function editForumTopic(topicId, bbcode) {
        const topic = await fetchForumDocument(forumTopicUrl(topicId));
        const editLink = topic.document.querySelector(
          'a.btn-edit[href*="mode=editpost"], a[href*="mode=editpost"]'
        );

        if (!editLink) {
          throw new Error(
            "O botão de editar não foi encontrado. Confirme o login e a permissão."
          );
        }

        return submitForumPostingForm(
          new URL(editLink.getAttribute("href"), CONFIG.forum.origin),
          bbcode,
          { clearEditReason: true }
        );
      }

      async function replyForumTopic(topicId, bbcode) {
        const replyUrl = new URL("/post", CONFIG.forum.origin);
        replyUrl.searchParams.set("t", topicId);
        replyUrl.searchParams.set("mode", "reply");
        return submitForumPostingForm(replyUrl, bbcode, {
          disableHtml: true
        });
      }

      function waitForPublishingDelay(label) {
        const seconds = Math.ceil(CONFIG.forum.automaticDelayMs / 1000);
        const status = document.getElementById("publish-status");

        return new Promise((resolve) => {
          let remaining = seconds;
          status.textContent = `${label} em ${remaining}s…`;
          const timer = window.setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
              window.clearInterval(timer);
              resolve();
              return;
            }
            status.textContent = `${label} em ${remaining}s…`;
          }, 1000);
        });
      }

      function createPublishingRequestId() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
          return window.crypto.randomUUID();
        }
        return `oceanlist-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`;
      }

      function publishThroughForumBridge(popup, request) {
        return new Promise((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            cleanup();
            reject(
              new Error(
                "A ponte do Forumeiros não respondeu. Instale ou atualize o script OceanList-Forumeiros-Bridge.js."
              )
            );
          }, CONFIG.forum.bridgeTimeoutMs);
          const interval = window.setInterval(() => {
            if (popup.closed) {
              cleanup();
              reject(new Error("A janela do fórum foi fechada antes do envio."));
              return;
            }
            popup.postMessage(request, CONFIG.forum.origin);
          }, 900);

          function cleanup() {
            window.clearTimeout(timeout);
            window.clearInterval(interval);
            window.removeEventListener("message", onMessage);
          }

          function onMessage(event) {
            if (
              event.origin !== CONFIG.forum.origin ||
              event.source !== popup ||
              !event.data ||
              event.data.type !== "OCEANLIST_FORUM_RESULT" ||
              event.data.requestId !== request.requestId
            ) {
              return;
            }

            cleanup();
            if (event.data.ok) {
              resolve(event.data);
            } else {
              reject(new Error(event.data.error || "Falha ao publicar no fórum."));
            }
          }

          window.addEventListener("message", onMessage);
          popup.postMessage(request, CONFIG.forum.origin);
        });
      }

      async function runAutomaticPublishing(kind) {
        if (appState.publishingBusy || !hasPublishingData()) return;

        const publishing = appState.publishing;
        const actions = {
          listing: {
            label: "Atualização da listagem",
            bridgeAction: "edit",
            topicId: requireTopicId(
              publishing.listingTopicId,
              "P2"
            ),
            bbcode: publishingText("listing")
          },
          consultation: {
            label: "Atualização da consulta",
            bridgeAction: "edit",
            topicId: requireTopicId(
              publishing.consultationTopicId,
              "Q2"
            ),
            bbcode: publishingText("consultation")
          },
          backup: {
            label: "Publicação do backup",
            bridgeAction: "reply",
            topicId: requireTopicId(publishing.backupTopicId, "R2"),
            bbcode: publishingText("backup")
          }
        };
        const action = actions[kind];
        if (!action) return;

        const sameForumOrigin =
          window.location.origin === CONFIG.forum.origin;
        const popup = sameForumOrigin
          ? null
          : window.open(
              forumTopicUrl(action.topicId),
              `oceanlist-forum-${action.topicId}`
            );

        if (!sameForumOrigin && !popup) {
          showToast(
            "Permita a abertura da janela do fórum para continuar.",
            "warning"
          );
          return;
        }

        appState.publishingBusy = true;
        updateMemberEditControls();
        renderPublishingDialog();

        try {
          await waitForPublishingDelay(action.label);
          document.getElementById("publish-status").textContent =
            `${action.label}: enviando…`;

          if (sameForumOrigin) {
            if (action.bridgeAction === "edit") {
              await editForumTopic(action.topicId, action.bbcode);
            } else {
              await replyForumTopic(action.topicId, action.bbcode);
            }
          } else {
            await publishThroughForumBridge(popup, {
              type: "OCEANLIST_FORUM_ACTION",
              requestId: createPublishingRequestId(),
              action: action.bridgeAction,
              topicId: action.topicId,
              bbcode: action.bbcode
            });
          }

          document.getElementById("publish-status").textContent =
            `${action.label} concluída.`;
          showToast(`${action.label} concluída no fórum.`, "success");
        } catch (error) {
          document.getElementById("publish-status").textContent = error.message;
          showToast(error.message, "error");
        } finally {
          appState.publishingBusy = false;
          updateMemberEditControls();
          renderPublishingDialog();
        }
      }

      async function loadOceanList(options = {}) {
        const { quiet = false } = options;
        setDataLoading(true);
        setWorkspaceState("", "Sincronizando");

        if (!appState.loaded) {
          const table = document.getElementById("members-table");
          const tableState = document.getElementById("table-state");
          table.hidden = true;
          tableState.hidden = false;
          tableState.textContent = "Carregando a base de membros…";
        }

        try {
          const response = await requestOceanList("bootstrap");
          const incomingRows = response.data.rows || [];
          appState.headers = response.data.headers || [];
          appState.maxDataRow = incomingRows.reduce(
            (maximum, row) => Math.max(maximum, Number(row.row) || 1),
            1
          );
          appState.rows = incomingRows;
          appState.settings = response.settings.rows || [];
          appState.publishing = response.publishing || null;
          appState.booleanColumns = detectBooleanColumns();
          sortMembers();
          appState.selectedMemberRows.clear();
          appState.loaded = true;

          renderMembers();
          renderSettings();
          updateSummary();
          updateDataTimestamp(response.meta && response.meta.generatedAt);
          setWorkspaceState("ready", "Sincronizado");

          if (!quiet) {
            showToast(
              `${formatCount(appState.rows.length)} registros atualizados.`,
              "success"
            );
          }
        } catch (error) {
          setWorkspaceState("error", "Conexão pendente");
          document.getElementById("members-table").hidden = true;
          const tableState = document.getElementById("table-state");
          tableState.hidden = false;
          tableState.textContent = error.message;
          document.getElementById("table-result").textContent =
            "Não foi possível carregar";
          showToast(error.message, "error");
        } finally {
          setDataLoading(false);
        }
      }

      function createFormField(label, value, index, options = {}) {
        const wrapper = document.createElement("div");
        wrapper.className = `form-field${options.wide ? " form-field--wide" : ""}`;

        const inputId =
          options.id || `${options.prefix || "field"}-${index}`;
        const fieldLabel = document.createElement("label");
        fieldLabel.htmlFor = inputId;
        fieldLabel.textContent = label;

        const input = document.createElement("input");
        input.id = inputId;
        input.name = inputId;
        input.type = options.type || "text";
        input.value = value ?? "";
        input.dataset.index = index;
        if (options.placeholder) input.placeholder = options.placeholder;
        if (options.min !== undefined) input.min = options.min;
        if (options.dataset) {
          Object.entries(options.dataset).forEach(([key, datasetValue]) => {
            input.dataset[key] = datasetValue;
          });
        }

        wrapper.append(fieldLabel, input);
        return wrapper;
      }

      function openSettingsEditor(rowNumber) {
        const item = appState.settings.find((entry) => entry.row === rowNumber);
        if (!item) return;

        appState.editingSettingsRow = rowNumber;
        document.getElementById("settings-editor-eyebrow").textContent =
          `Cargo · linha ${rowNumber}`;
        const fields = document.getElementById("settings-editor-fields");
        fields.replaceChildren();

        const roleField = document.createElement("div");
        roleField.className = "form-field";
        const roleLabel = document.createElement("label");
        roleLabel.htmlFor = "settings-field-0";
        roleLabel.textContent = "Cargo";
        roleField.append(
          roleLabel,
          createRoleSelect(item.role, {
            id: "settings-field-0",
            index: 0,
            className: "form-select",
            label: "Cargo"
          })
        );

        const vacanciesField = createFormField(
          "Quantidade de vagas",
          item.vacancies,
          1,
          {
            id: "settings-field-1",
            type: "number",
            placeholder: "0",
            min: 0
          }
        );
        fields.append(roleField, vacanciesField);

        document.getElementById("settings-editor").showModal();
      }

      function closeSettingsEditor() {
        appState.editingSettingsRow = null;
        document.getElementById("settings-editor").close();
      }

      async function saveRoleSettings(event) {
        event.preventDefault();
        const item = appState.settings.find(
          (entry) => entry.row === appState.editingSettingsRow
        );
        if (!item) return;

        const button = document.getElementById("save-settings");
        const inputs = Array.from(
          document.querySelectorAll(
            "#settings-editor-fields input, #settings-editor-fields select"
          )
        ).sort((left, right) => Number(left.dataset.index) - Number(right.dataset.index));
        const values = inputs.map((input) => input.value.trim());

        button.disabled = true;
        button.textContent = "Salvando…";

        try {
          await requestOceanList("saveSettings", {
            rows: [
              {
                row: item.row,
                role: values[0],
                vacancies: values[1]
              }
            ]
          });

          item.role = values[0];
          item.vacancies = values[1] === "" ? "" : Number(values[1]);
          closeSettingsEditor();
          renderSettings();
          updateSummary();
          updateDataTimestamp();
          showToast("Cargo e vagas atualizados em N:O.", "success");
        } catch (error) {
          showToast(error.message, "error");
        } finally {
          button.disabled = false;
          button.textContent = "Salvar cargo";
        }
      }

      function createEditorFieldset(title, description) {
        const section = document.createElement("section");
        section.className = "editor-fieldset";

        const heading = document.createElement("h3");
        heading.className = "editor-fieldset__title";
        heading.textContent = title;

        const copy = document.createElement("p");
        copy.className = "editor-fieldset__description";
        copy.textContent = description;

        const grid = document.createElement("div");
        grid.className = "editor-grid";
        section.append(heading, copy, grid);
        return { section, grid };
      }

      function normalizeHexColor(value) {
        const trimmed = String(value || "").trim();
        if (!trimmed) return "";
        return (trimmed.startsWith("#") ? trimmed : `#${trimmed}`).toUpperCase();
      }

      function openLayoutEditor() {
        const owner = getLayoutOwner();
        if (!owner) return;

        appState.editingLayoutOwnerRow = owner.row;
        const fields = document.getElementById("layout-editor-fields");
        fields.replaceChildren();

        const bannerGroup = createEditorFieldset(
          "Banner",
          "Imagem principal que será usada no topo da futura listagem em BBCode."
        );
        bannerGroup.grid.appendChild(
          createFormField("URL do banner", owner.banner, 0, {
            id: "layout-banner",
            type: "url",
            placeholder: "https://...",
            wide: true
          })
        );

        const colorGroup = createEditorFieldset(
          "Paleta de cores",
          "Cores independentes dos cargos, armazenadas verticalmente em M:M."
        );
        appState.settings.forEach((item, index) => {
          colorGroup.grid.appendChild(
            createFormField(`Cor ${index + 1}`, item.color, index, {
              id: `layout-color-${item.row}`,
              placeholder: "#0EA5E9",
              dataset: { layoutColorRow: String(item.row) }
            })
          );
        });

        const topicsGroup = createEditorFieldset(
          "Tópicos de publicação",
          "IDs numéricos da listagem, consulta e backup armazenados em P2:R2."
        );
        ["Listagem · P2", "Consulta · Q2", "Backup · R2"].forEach(
          (label, index) => {
            topicsGroup.grid.appendChild(
              createFormField(
                label,
                (owner.topicIds || [])[index] || "",
                index,
                {
                  id: `layout-topic-${index}`,
                  type: "text",
                  placeholder: "1"
                }
              )
            );
          }
        );

        const linksGroup = createEditorFieldset(
          "Links importantes",
          "Dois espaços em S:T reservados para links usados no BBCode."
        );
        Array.from({ length: 2 }, (_, index) => {
          linksGroup.grid.appendChild(
            createFormField(
              `Link importante ${index + 1}`,
              (owner.links || [])[index] || "",
              index,
              {
                id: `layout-link-${index}`,
                type: "url",
                placeholder: "https://...",
                wide: true
              }
            )
          );
        });

        fields.append(
          bannerGroup.section,
          colorGroup.section,
          topicsGroup.section,
          linksGroup.section
        );
        document.getElementById("layout-editor").showModal();
      }

      function closeLayoutEditor() {
        appState.editingLayoutOwnerRow = null;
        document.getElementById("layout-editor").close();
      }

      async function saveLayoutSettings(event) {
        event.preventDefault();
        const owner = appState.settings.find(
          (item) => item.row === appState.editingLayoutOwnerRow
        );
        if (!owner) return;

        const banner = document.getElementById("layout-banner").value.trim();
        const topicIds = Array.from({ length: 3 }, (_, index) =>
          document.getElementById(`layout-topic-${index}`).value.trim()
        );
        const links = Array.from({ length: 2 }, (_, index) =>
          document.getElementById(`layout-link-${index}`).value.trim()
        );
        const colors = new Map(
          Array.from(
            document.querySelectorAll("[data-layout-color-row]")
          ).map((input) => [
            Number(input.dataset.layoutColorRow),
            normalizeHexColor(input.value)
          ])
        );
        const updates = new Map();

        function mergeUpdate(row, fields) {
          updates.set(row, { ...(updates.get(row) || { row }), ...fields });
        }

        if (
          banner !== String(owner.banner || "").trim() ||
          topicIds.some(
            (topicId, index) =>
              topicId !== String((owner.topicIds || [])[index] || "").trim()
          ) ||
          links.some(
            (link, index) =>
              link !== String((owner.links || [])[index] || "").trim()
          )
        ) {
          mergeUpdate(owner.row, { banner, topicIds, links });
        }

        appState.settings.forEach((item) => {
          const color = colors.get(item.row) || "";
          if (color !== normalizeHexColor(item.color)) {
            mergeUpdate(item.row, { color });
          }
        });

        if (!updates.size) {
          closeLayoutEditor();
          showToast("Nenhuma alteração nos recursos do BBCode.", "info");
          return;
        }

        const button = document.getElementById("save-layout");
        button.disabled = true;
        button.textContent = "Salvando…";

        try {
          const rows = Array.from(updates.values());
          await requestOceanList("saveSettings", { rows });

          rows.forEach((update) => {
            const item = appState.settings.find(
              (entry) => entry.row === update.row
            );
            if (!item) return;
            if (Object.prototype.hasOwnProperty.call(update, "banner")) {
              item.banner = update.banner;
            }
            if (Object.prototype.hasOwnProperty.call(update, "color")) {
              item.color = update.color;
            }
            if (Object.prototype.hasOwnProperty.call(update, "links")) {
              item.links = update.links.slice();
            }
            if (Object.prototype.hasOwnProperty.call(update, "topicIds")) {
              item.topicIds = update.topicIds.slice();
              if (appState.publishing) {
                appState.publishing.listingTopicId = update.topicIds[0] || "";
                appState.publishing.consultationTopicId =
                  update.topicIds[1] || "";
                appState.publishing.backupTopicId = update.topicIds[2] || "";
              }
            }
          });

          closeLayoutEditor();
          renderSettings();
          updateDataTimestamp();
          showToast("Recursos do BBCode atualizados em L:M e P:T.", "success");
        } catch (error) {
          showToast(error.message, "error");
        } finally {
          button.disabled = false;
          button.textContent = "Salvar recursos";
        }
      }

      function parseTSV(text) {
        return text
          .replace(/\r/g, "")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => line.split("\t").map((cell) => cell.trim()));
      }

      function cleanCell(value) {
        return String(value || "").replace(/^"|"$/g, "").trim();
      }

      function normalizeNick(value) {
        return cleanCell(value).toLocaleLowerCase("pt-BR");
      }

      function findMember(username, source) {
        const target = normalizeNick(username);
        const rows = parseTSV(source);

        for (const row of rows) {
          if (row.length < 2) continue;
          const role = cleanCell(row[0]);
          const nick = cleanCell(row[1]);
          if (nick && normalizeNick(nick) === target) {
            return { nick, role: role || "Membro" };
          }
        }

        return null;
      }

      async function fetchForumUsername() {
        let response;

        try {
          response = await fetch("/forum", {
            method: "GET",
            credentials: "include",
            cache: "no-store"
          });
        } catch {
          throw new Error("Não foi possível consultar sua sessão no fórum.");
        }

        if (!response.ok) {
          throw new Error("Não foi possível confirmar seu login no fórum.");
        }

        const forumHtml = await response.text();
        const match = forumHtml.match(
          /_userdata\[['"]username['"]\]\s*=\s*['"]([^'"]+)['"]/i
        );
        const username = match ? cleanCell(match[1]) : "";

        if (!username || username.toLocaleLowerCase("pt-BR") === "anônimo") {
          throw new Error("Você precisa estar conectado ao fórum para continuar.");
        }

        return username;
      }

      function denyAccess(message) {
        const authScreen = document.getElementById("auth-screen");
        authScreen.classList.add("is-denied");
        document.getElementById("auth-title").textContent = "Acesso negado";
        document.getElementById("auth-message").textContent = message;
        authScreen.setAttribute("role", "alert");
      }

      function allowAccess(user) {
        currentUser = Object.freeze({ ...user });

        const authScreen = document.getElementById("auth-screen");
        const userBlock = document.getElementById("topbar-user");
        const avatar = document.getElementById("user-avatar");

        document.getElementById("user-display-name").textContent = user.nick;
        document.getElementById("user-display-role").textContent = user.role;
        avatar.src =
          `https://www.habbo.com.br/habbo-imaging/avatarimage?user=${encodeURIComponent(user.nick)}` +
          "&direction=2&head_direction=3&gesture=sml&size=m&headonly=1";
        avatar.alt = `Avatar de ${user.nick}`;
        userBlock.classList.add("is-visible");
        authScreen.classList.add("is-hidden");

        window.setTimeout(() => {
          authScreen.hidden = true;
        }, 250);
      }

      async function initializeAuthentication() {
        try {
          if (CONFIG.auth.temporaryUser) {
            allowAccess(CONFIG.auth.temporaryUser);
            showToast(
              "",
              "success",
              `Bem-vindo, ${CONFIG.auth.temporaryUser.nick}`
            );
            await loadOceanList({ quiet: true });
            return;
          }

          const username = await fetchForumUsername();
          const membersSource = await fetchMembers();
          const member = findMember(username, membersSource);

          if (!member) {
            throw new Error(
              "Seu usuário não possui permissão na planilha de membros."
            );
          }

          allowAccess(member);
          showToast("", "success", `Bem-vindo, ${member.nick}`);
          await loadOceanList({ quiet: true });
        } catch (error) {
          denyAccess(
            error && error.message
              ? error.message
              : "Não foi possível validar seu acesso."
          );
        }
      }

      async function fetchMembers(options = {}) {
        const url = spreadsheetExportUrl(
          CONFIG.sheets.membersId,
          CONFIG.sheets.membersGid,
          "tsv"
        );
        return fetchViaWorker(url, options);
      }

      function showToast(message, type = "info", title = "") {
        const styles = {
          success: {
            title: "Sucesso",
            icon: `
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="8.5"></circle>
                <path class="toast__icon-shape" d="m8 12.2 2.6 2.6L16.5 9"></path>
              </svg>
            `
          },
          error: {
            title: "Erro",
            icon: `
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="8.5"></circle>
                <path class="toast__icon-shape" d="m9 9 6 6M15 9l-6 6"></path>
              </svg>
            `
          },
          warning: {
            title: "Atenção",
            icon: `
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10.3 4.6 3.4 17a2 2 0 0 0 1.8 3h13.6a2 2 0 0 0 1.8-3L13.7 4.6a2 2 0 0 0-3.4 0Z"></path>
                <path class="toast__icon-shape" d="M12 9v4.2M12 16.5h.01"></path>
              </svg>
            `
          },
          info: {
            title: "Informação",
            icon: `
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="8.5"></circle>
                <path class="toast__icon-shape" d="M12 10.5v5M12 7.5h.01"></path>
              </svg>
            `
          }
        };

        const style = styles[type] || styles.info;
        const toast = document.createElement("div");
        toast.className = "toast";
        toast.dataset.type = styles[type] ? type : "info";
        toast.setAttribute("role", type === "error" ? "alert" : "status");

        const toastIcon = document.createElement("span");
        toastIcon.className = "toast__icon";
        toastIcon.innerHTML = style.icon;

        const toastContent = document.createElement("span");
        toastContent.className = "toast__content";
        const toastTitle = document.createElement("strong");
        toastTitle.className = "toast__title";
        toastTitle.textContent = title || style.title;
        toastContent.appendChild(toastTitle);

        if (message) {
          const toastMessage = document.createElement("span");
          toastMessage.className = "toast__message";
          toastMessage.textContent = message;
          toastContent.appendChild(toastMessage);
        }

        toast.append(toastIcon, toastContent);
        document.getElementById("toast-container").appendChild(toast);

        requestAnimationFrame(() => {
          toast.classList.add("is-visible");
          window.setTimeout(() => toast.classList.add("is-expanded"), 420);
        });

        const duration = type === "error" ? 5400 : 4700;
        window.setTimeout(() => {
          toast.classList.remove("is-expanded");
        }, duration - 850);

        window.setTimeout(() => {
          toast.classList.add("is-leaving");
        }, duration - 300);

        window.setTimeout(() => toast.remove(), duration + 120);
      }

      function setSidebarOpen(isOpen) {
        const sidebar = document.getElementById("app-sidebar");
        const menuButton = document.getElementById("mobile-menu-button");
        sidebar.classList.toggle("is-open", isOpen);
        menuButton.setAttribute("aria-expanded", String(isOpen));
        menuButton.setAttribute(
          "aria-label",
          isOpen ? "Fechar menu principal" : "Abrir menu principal"
        );
      }

      function navigateToView(viewName, options = {}) {
        if (!["members", "settings"].includes(viewName)) return;

        if (
          !options.force &&
          viewName !== "members" &&
          (appState.editingMembers ||
            appState.removingMembers ||
            appState.addingMember)
        ) {
          showToast(
            "Conclua ou cancele a ação atual antes de trocar de página.",
            "warning"
          );
          return;
        }

        appState.currentView = viewName;
        document.querySelectorAll(".app-view").forEach((view) => {
          view.hidden = view.dataset.view !== viewName;
        });

        document.querySelectorAll("[data-view-target]").forEach((button) => {
          const isActive = button.dataset.viewTarget === viewName;
          button.classList.toggle("is-active", isActive);
          if (isActive) {
            button.setAttribute("aria-current", "page");
          } else {
            button.removeAttribute("aria-current");
          }
        });

        const isSettings = viewName === "settings";
        document.getElementById("topbar-page-title").textContent = isSettings
          ? "Configurações da listagem"
          : "Controle de membros";
        document.title = isSettings
          ? "Configurações · OceanList"
          : "OceanList";

        const page = document.querySelector(".page");
        page.scrollTop = 0;
        setSidebarOpen(false);
      }

      window.OceanList = Object.freeze({
        config: CONFIG,
        worker: Object.freeze({
          buildUrl: buildWorkerUrl,
          fetch: fetchViaWorker
        }),
        auth: Object.freeze({
          getCurrentUser: () => currentUser,
          refresh: initializeAuthentication
        }),
        sheets: Object.freeze({
          spreadsheetExportUrl,
          fetchMembers,
          request: requestOceanList,
          parseTSV
        })
      });

      document
        .getElementById("refresh-members")
        .addEventListener("click", () => loadOceanList());

      document
        .getElementById("refresh-settings")
        .addEventListener("click", () => loadOceanList());

      document
        .getElementById("open-publishing")
        .addEventListener("click", openPublishingDialog);

      document
        .getElementById("close-publishing")
        .addEventListener("click", closePublishingDialog);

      document
        .getElementById("dismiss-publishing")
        .addEventListener("click", closePublishingDialog);

      document
        .getElementById("publish-mode-manual")
        .addEventListener("click", () => setPublishingMode("manual"));

      document
        .getElementById("publish-mode-auto")
        .addEventListener("click", () => setPublishingMode("automatic"));

      document
        .querySelectorAll("[data-copy-publish]")
        .forEach((button) => {
          button.addEventListener("click", () =>
            copyPublishingText(button.dataset.copyPublish)
          );
        });

      document
        .querySelectorAll("[data-publish-action]")
        .forEach((button) => {
          button.addEventListener("click", () => {
            runAutomaticPublishing(button.dataset.publishAction).catch(
              (error) => showToast(error.message, "error")
            );
          });
        });

      document
        .getElementById("publishing-dialog")
        .addEventListener("click", (event) => {
          if (event.target === event.currentTarget) closePublishingDialog();
        });

      document
        .getElementById("publishing-dialog")
        .addEventListener("cancel", (event) => {
          if (appState.publishingBusy) {
            event.preventDefault();
          }
        });

      document
        .getElementById("member-search")
        .addEventListener("input", (event) => {
          appState.search = event.target.value;
          renderMembers();
        });

      document
        .getElementById("edit-members")
        .addEventListener("click", beginMemberEditing);

      document
        .getElementById("organize-members")
        .addEventListener("click", organizeMemberList);

      document
        .getElementById("save-members-edit")
        .addEventListener("click", saveMemberList);

      document
        .getElementById("cancel-members-edit")
        .addEventListener("click", cancelMemberEditing);

      document
        .getElementById("add-member")
        .addEventListener("click", openAddMemberEditor);

      document
        .getElementById("add-member-form")
        .addEventListener("submit", saveNewMember);

      document
        .getElementById("close-add-member")
        .addEventListener("click", closeAddMemberEditor);

      document
        .getElementById("cancel-add-member")
        .addEventListener("click", closeAddMemberEditor);

      document
        .getElementById("add-member-editor")
        .addEventListener("click", (event) => {
          if (event.target === event.currentTarget) closeAddMemberEditor();
        });

      document
        .getElementById("add-member-editor")
        .addEventListener("cancel", (event) => {
          if (appState.savingMembers) {
            event.preventDefault();
            return;
          }
          appState.addingMember = false;
          updateMemberEditControls();
        });

      document
        .getElementById("add-member-editor")
        .addEventListener("close", () => {
          appState.addingMember = false;
          updateMemberEditControls();
        });

      document
        .getElementById("remove-members")
        .addEventListener("click", beginMemberRemoval);

      document
        .getElementById("confirm-members-remove")
        .addEventListener("click", confirmMemberRemoval);

      document
        .getElementById("cancel-members-remove")
        .addEventListener("click", cancelMemberRemoval);

      document
        .getElementById("settings-editor-form")
        .addEventListener("submit", saveRoleSettings);

      document
        .getElementById("close-settings-editor")
        .addEventListener("click", closeSettingsEditor);

      document
        .getElementById("cancel-settings-editor")
        .addEventListener("click", closeSettingsEditor);

      document
        .getElementById("settings-editor")
        .addEventListener("click", (event) => {
          if (event.target === event.currentTarget) closeSettingsEditor();
        });

      document
        .getElementById("edit-layout")
        .addEventListener("click", openLayoutEditor);

      document
        .getElementById("layout-editor-form")
        .addEventListener("submit", saveLayoutSettings);

      document
        .getElementById("close-layout-editor")
        .addEventListener("click", closeLayoutEditor);

      document
        .getElementById("cancel-layout-editor")
        .addEventListener("click", closeLayoutEditor);

      document
        .getElementById("layout-editor")
        .addEventListener("click", (event) => {
          if (event.target === event.currentTarget) closeLayoutEditor();
        });

      document
        .getElementById("mobile-menu-button")
        .addEventListener("click", () => {
          const sidebar = document.getElementById("app-sidebar");
          setSidebarOpen(!sidebar.classList.contains("is-open"));
        });

      document
        .getElementById("sidebar-overlay")
        .addEventListener("click", () => setSidebarOpen(false));

      document.querySelectorAll("[data-view-target]").forEach((navItem) => {
        navItem.addEventListener("click", () => {
          navItem.classList.remove("is-pulsing");
          void navItem.offsetWidth;
          navItem.classList.add("is-pulsing");
          window.setTimeout(
            () => navItem.classList.remove("is-pulsing"),
            440
          );
          navigateToView(navItem.dataset.viewTarget);
        });
      });

      document
        .getElementById("sidebar-logo")
        .addEventListener("click", (event) => {
          event.preventDefault();
          navigateToView("members");
        });

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") setSidebarOpen(false);
      });

      window.addEventListener("resize", () => {
        if (window.innerWidth >= 768) setSidebarOpen(false);
      });

      navigateToView(
        window.location.hash === "#configuracoes" ? "settings" : "members",
        { force: true }
      );
      initializeAuthentication();
    })();
