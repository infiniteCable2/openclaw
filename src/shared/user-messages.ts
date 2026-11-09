import type { FailoverReason } from "../agents/failover/signal.js";
import type { GatewayStorageFailure } from "../infra/sqlite-error-diagnostics.js";
import type { WorkshopChangeAction } from "../skills/workshop-changes/changes.kernel.js";
import { resolveUserMessageLocale, type UserMessageLocale } from "./language.js";

/** Native user-facing copy. Protocol codes, tool names and diagnostics stay separate. */
type UserMessages = {
  compactionNotice: Readonly<{
    start: string;
    end: string;
    incomplete: string;
    skipped: string;
    queued: string;
    memory_flush_degraded: string;
    context_bounded: string;
    degraded: string;
    summaryRefused: string;
  }>;
  voiceActionNotExecuted(toolName: string): string;
  voiceConfirmationRequest: string;
  voiceConfirmationPending: string;
  voiceConfirmationNoLongerCurrent: string;
  voiceControlFailed: string;
  voiceControlQueueFull: string;
  voiceInputFailed: string;
  voiceTranscriptionFailed: string;
  voiceConnectionFailed: string;
  voiceNoActiveRun(action: "cancel" | "steer"): string;
  voiceCancelled: string;
  voiceCancelFailed: string;
  voiceFollowupQueued: string;
  voiceSteered: string;
  voiceInputUnconfirmed: string;
  voiceScopedSteeringUnavailable: string;
  voiceCompacting: string;
  voiceNotAcceptingSteering: string;
  voiceFollowupRejected: string;
  voiceSteeringRejected: string;
  voiceLastRequestFinished: string;
  voiceIdle: string;
  voiceToolStarting(name?: string): string;
  voiceToolFinished(name?: string): string;
  voiceToolWorking(name?: string, phase?: string): string;
  voiceToolRunning(name: string): string;
  voiceWaitingOnModel: string;
  voiceWorking: string;
  replyUnavailable: string;
  replyRestarting: string;
  replyConversationChanged: string;
  replyEmpty: string;
  replyWorkerTimeout: string;
  replyQueueFull: string;
  replyQueueFullNoRetry: string;
  replyMissing: string;
  replyMissingSideEffect: string;
  replyShuttingDown: string;
  replyWriterFenceBlocked: string;
  replyStalled: string;
  replyRateLimited: string;
  replyMediaContinuing: string;
  replyNoVisible: string;
  replyReference(reference: string): string;
  replyDetailsHint: string;
  replyTaskIncomplete: string;
  replyFinishFailed: string;
  replyContinuing: string;
  replyBackgroundFailed: string;
  replyBackgroundLogs: string;
  replyModelSwitchFailed: string;
  replyContextOverflow: string;
  replyDiagnosticFailure(detail: string): string;
  replyContextRecoveryFailed: string;
  replyLargerContextHint: string;
  replyPostCompactionFailed: string;
  requestFailure: Readonly<Record<FailoverReason, string>>;
  storageFailure: Readonly<Record<GatewayStorageFailure, string>>;
  runtimeCoordinationFailure: Readonly<Record<string, string>>;
  skillWorkshopAction: Readonly<Record<WorkshopChangeAction, string>>;
  skillWorkshopNotice(parts: string): string;
};

const catalogs: Record<UserMessageLocale, UserMessages> = {
  en: {
    compactionNotice: {
      start: "🧹 Compacting context...",
      end: "🧹 Compaction complete",
      incomplete: "🧹 Compaction incomplete",
      degraded:
        "⚠️ Context was summarized with reduced detail. Older details or pending requests may be missing; resend essential information if needed. Full history remains saved.",
      summaryRefused:
        "⚠️ The summarizer declined. Recent turns were kept; older messages remain saved but are outside active context. Resend essential older details if needed.",
      skipped: "🧹 Compaction not needed",
      queued:
        "🧹 Compacting context. Your message has been received and will be handled afterward.",
      memory_flush_degraded: "⚠️ Memory maintenance temporarily failed; continuing your reply.",
      context_bounded:
        "⚠️ Continuing with bounded recent context. Older history outside that window is omitted for this turn; resend any earlier details needed for your request. Full history remains saved.",
    },
    skillWorkshopAction: {
      create: "created",
      patch: "updated",
      write_file: "updated",
      remove_file: "updated",
      archive: "archived",
      restore: "restored",
    },
    skillWorkshopNotice: (parts) => `💾 Learned: ${parts}. Say "undo" to revert this skill change.`,
    replyPostCompactionFailed:
      "⚠️ Context compaction succeeded, but the later model request still failed.",
    replyContextRecoveryFailed:
      "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session.",
    replyLargerContextHint:
      "Try starting a fresh session or using a model with a larger context window.",
    replyContinuing: "I’m continuing this work and will send the result when it is ready.",
    replyBackgroundFailed: "⚠️ The background check did not complete.",
    replyBackgroundLogs: "Troubleshooting: run `openclaw logs --follow` in a terminal.",
    replyModelSwitchFailed:
      "⚠️ Model switch could not be completed. The requested model may be temporarily unavailable. Please try again shortly.",
    replyContextOverflow:
      "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model.",
    replyDiagnosticFailure: (detail) =>
      `⚠️ Agent failed before reply: ${detail}${/[.!?]$/u.test(detail) ? "" : "."} Please try again, or use /new to start a fresh session.`,
    requestFailure: {
      auth: "Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.",
      auth_permanent:
        "The AI service isn't accepting your login. Sign in again under Models in the Control UI or run `openclaw configure`.",
      format:
        "The AI service couldn't accept this request. Try a new conversation with /new, or choose another model in the Control UI.",
      rate_limit: "The AI service needs a short break. Please try again in a few minutes.",
      overloaded: "The AI service is busy. Please try again in a moment, or choose another model.",
      billing:
        "The AI service reported a billing problem. Check your account's credit balance and usage limits before trying again.",
      server_error: "The AI service is having trouble. Please try again in a moment.",
      route_unavailable: "The provider cannot serve this model right now. Choose another model.",
      timeout:
        "The request took too long. Check the conversation for any completed work before trying again.",
      tls_certificate:
        "Couldn't connect securely to the AI service. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.",
      context_overflow:
        "This conversation is too long for the model. Try /compact, or start a new conversation with /new.",
      model_not_found:
        "This model was not found. Choose another model in the Control UI or run `openclaw configure`.",
      session_expired:
        "Your AI session expired. Start a new conversation with /new. If it happens again, sign in under Models in the Control UI.",
      empty_response: "The AI service returned an empty reply. Please try again.",
      no_error_details: "",
      unclassified: "",
      unknown: "",
    },
    storageFailure: {
      "storage-worker-memory":
        "OpenClaw's storage worker ran out of memory. Ask the operator to check memory pressure and the logs. Restarting this session alone will not fix it.",
      unavailable:
        "The database connection was lost. This operation was rolled back; nothing from it was saved. Please retry.",
      session_actor_reconciliation:
        "OpenClaw could not confirm the last conversation update. Some work may have been saved. Wait for current work to finish, then check the history before retrying. If this persists, restart OpenClaw.",
      "57014":
        "PostgreSQL canceled a database operation or it timed out. Check for completed work before retrying. If it recurs, ask the operator to check database timeouts and activity.",
      SQLITE_BUSY:
        "OpenClaw is busy saving your conversation. Wait a moment, then check the conversation before trying again.",
      SQLITE_LOCKED:
        "OpenClaw is busy saving your conversation. Wait a moment, then check the conversation before trying again.",
      SQLITE_FULL:
        "OpenClaw couldn't save your conversation because the disk is full. Free up space on the computer running OpenClaw before continuing.",
      SQLITE_READONLY:
        "OpenClaw doesn't have permission to save your conversation. Check folder permissions on the computer running OpenClaw.",
      SQLITE_IOERR:
        "OpenClaw couldn't save your conversation. Check the storage on the computer running OpenClaw before continuing.",
      transcript_writer_fenced:
        "This conversation changed while OpenClaw was working. Check its latest messages before continuing.",
    },
    runtimeCoordinationFailure: {
      child_completion_delivery_failed:
        "The child result could not be delivered here. Your conversation is preserved. Check the child sessions for saved work, then retry or resend your request.",
      codex_node_disconnected: "Codex execution node disconnected. Start a fresh attempt.",
      node_runner_update_required:
        "The device worker requires an update before it can host sessions. Run `openclaw update`, reconnect it, then run `openclaw node restart` on a headless node before trying again.",
      "runner-offline":
        "The device runner is offline. Reconnect it, retry later, or bring the session back to this gateway.",
    },
    voiceControlFailed: "OpenClaw could not process that voice control. Please try again.",
    voiceInputFailed: "Native conversation input failed",
    voiceTranscriptionFailed:
      "OpenClaw could not transcribe that input. Check the connection and try again.",
    voiceConnectionFailed:
      "OpenClaw could not complete this voice request. Check the connection and try again.",
    voiceControlQueueFull:
      "OpenClaw's voice control queue is full. Please try again after the pending controls finish.",
    voiceNoActiveRun: (action) => `There is no active OpenClaw run to ${action}.`,
    voiceCancelled: "Cancelled the active OpenClaw run.",
    voiceCancelFailed: "OpenClaw could not cancel the active run.",
    voiceFollowupQueued: "Queued that follow-up for the active OpenClaw run.",
    voiceSteered: "Got it. I steered the active run.",
    voiceInputUnconfirmed:
      "OpenClaw could not confirm that input. It was not sent again; check the conversation before retrying.",
    voiceScopedSteeringUnavailable:
      "This agent runtime cannot safely accept scoped voice steering. Check status, cancel the run, or start a new explicit request. Update the runtime when guarded injection is supported.",
    voiceCompacting: "OpenClaw is compacting the active run and cannot accept voice steering yet.",
    voiceNotAcceptingSteering:
      "OpenClaw has an active run, but it is not currently accepting steering.",
    voiceFollowupRejected: "OpenClaw could not queue that follow-up.",
    voiceSteeringRejected: "OpenClaw could not steer the active run.",
    voiceLastRequestFinished: "OpenClaw finished the last voice request.",
    voiceIdle: "I'm not working on an active request right now.",
    voiceToolStarting: (name) =>
      name ? `OpenClaw is starting ${name}.` : "OpenClaw is starting a tool.",
    voiceToolFinished: (name) =>
      name
        ? `OpenClaw finished ${name} and is continuing.`
        : "OpenClaw finished a tool and is continuing.",
    voiceToolWorking: (name, phase) =>
      name
        ? `OpenClaw is working in ${name}${phase ? ` (${phase})` : ""}.`
        : "OpenClaw is still working.",
    voiceToolRunning: (name) => `OpenClaw is running ${name}.`,
    voiceWaitingOnModel: "OpenClaw is waiting on the model.",
    voiceWorking: "OpenClaw is working on the current voice request.",
    replyUnavailable:
      "⚠️ OpenClaw couldn't finish this request. Check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    replyRestarting: "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
    replyConversationChanged:
      "⚠️ This conversation changed before your message could start. Check the latest messages, then try again if needed.",
    replyEmpty:
      "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.",
    replyWorkerTimeout: "A local worker task timed out. Please try again.",
    replyQueueFull:
      "This message was not queued because the session queue is full. Please try again after the current response finishes.",
    replyQueueFullNoRetry: "This message was not queued because the session queue is full.",
    replyMissing: "No answer was returned. Ask again if you still need one.",
    replyMissingSideEffect:
      "No answer was returned. Ask again if you still need one. Note: some tool actions may have already been executed — please verify before retrying.",
    replyRateLimited:
      "⚠️ This turn was stopped while the model provider was rate-limiting requests. Please try again in a few minutes.",
    replyMediaContinuing: "I’m continuing this work and will send the result when it is ready.",
    replyShuttingDown: "⚠️ Previous run is still shutting down. Please try again in a moment.",
    replyWriterFenceBlocked:
      "⚠️ Previous run could not be safely retired because its writer is still active. Start a separate session or restart the Gateway before retrying this session.",
    replyStalled:
      "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
    replyNoVisible:
      "⚠️ OpenClaw couldn't produce or deliver a reply. Please try again. If this keeps happening, ask the operator to check the gateway logs.",
    replyReference: (reference) => `Reference: ${reference}.`,
    replyDetailsHint:
      "For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.",
    replyTaskIncomplete:
      "⚠️ The task couldn't finish. Some actions may have completed; check their results before continuing.",
    replyFinishFailed: "OpenClaw couldn't finish this reply.",
    voiceActionNotExecuted: (toolName) =>
      `The high-impact voice action "${toolName}" was not executed.`,
    voiceConfirmationRequest:
      'Ask the user to say "yes" to confirm this action or "no" to cancel it.',
    voiceConfirmationPending:
      'One pending action has not run. Say "yes" to confirm that action or "no" to cancel it.',
    voiceConfirmationNoLongerCurrent:
      "An action in that request was not run because its spoken confirmation is no longer current. Make a new request if you still want it.",
  },
  de: {
    compactionNotice: {
      start: "🧹 Ich fasse den Kontext zusammen...",
      end: "🧹 Der Kontext ist zusammengefasst.",
      incomplete: "🧹 Die Kontextzusammenfassung ist noch nicht abgeschlossen.",
      degraded:
        "⚠️ Der Kontext wurde mit weniger Details zusammengefasst. Ältere Angaben oder offene Anfragen können fehlen; sende wichtige Informationen bei Bedarf erneut. Der vollständige Verlauf bleibt gespeichert.",
      summaryRefused:
        "⚠️ Das Modell hat die Zusammenfassung abgelehnt. Neuere Beiträge bleiben im Kontext; ältere Nachrichten bleiben gespeichert. Sende benötigte ältere Details bitte erneut.",
      skipped: "🧹 Eine Kontextzusammenfassung ist nicht nötig.",
      queued:
        "🧹 Ich fasse den Kontext zusammen. Deine Nachricht ist angekommen und wird danach bearbeitet.",
      memory_flush_degraded:
        "⚠️ Die Gedächtnispflege ist vorübergehend fehlgeschlagen. Ich fahre mit deiner Antwort fort.",
      context_bounded:
        "⚠️ Ich fahre mit dem jüngeren Kontext fort. Ältere Inhalte außerhalb dieses Fensters fehlen für diese Anfrage. Sende benötigte frühere Details bitte erneut. Der vollständige Verlauf bleibt gespeichert.",
    },
    skillWorkshopAction: {
      create: "erstellt",
      patch: "aktualisiert",
      write_file: "aktualisiert",
      remove_file: "aktualisiert",
      archive: "archiviert",
      restore: "wiederhergestellt",
    },
    skillWorkshopNotice: (parts) =>
      `💾 Gelernt: ${parts}. Sage "rückgängig", um diese Skill-Änderung zurückzunehmen.`,
    replyPostCompactionFailed:
      "⚠️ Der Kontext wurde erfolgreich verkürzt, aber die anschließende Modellanfrage ist trotzdem fehlgeschlagen.",
    replyContextRecoveryFailed:
      "⚠️ Die automatische Kontextverkürzung konnte diesen Auftrag nicht wiederherstellen. Die Unterhaltung bleibt der aktuellen Sitzung zugeordnet. Bitte versuche es erneut, verwende /compact oder starte mit /new eine neue Sitzung.",
    replyLargerContextHint:
      "Versuche eine neue Sitzung oder ein Modell mit größerem Kontextfenster.",
    replyContinuing: "Ich arbeite daran weiter und sende dir das Ergebnis, sobald es fertig ist.",
    replyBackgroundFailed: "⚠️ Die Hintergrundprüfung wurde nicht abgeschlossen.",
    replyBackgroundLogs: "Zur Fehlersuche: Führe `openclaw logs --follow` im Terminal aus.",
    replyModelSwitchFailed:
      "⚠️ Das Modell konnte nicht gewechselt werden. Das gewünschte Modell ist möglicherweise vorübergehend nicht verfügbar. Bitte versuche es gleich erneut.",
    replyContextOverflow:
      "⚠️ Die Anfrage ist für dieses Modell zu umfangreich. Versuche eine kürzere Nachricht oder ein Modell mit größerem Kontextfenster.",
    replyDiagnosticFailure: (detail) =>
      `⚠️ Der Agent konnte nicht antworten: ${detail}${/[.!?]$/u.test(detail) ? "" : "."} Bitte versuche es erneut oder starte mit /new eine neue Sitzung.`,
    requestFailure: {
      auth: "Die Anmeldung beim KI-Dienst ist fehlgeschlagen. Melde dich in der Control UI unter Modelle erneut an oder führe `openclaw configure` aus.",
      auth_permanent:
        "Der KI-Dienst akzeptiert deine Anmeldung nicht. Melde dich in der Control UI unter Modelle erneut an oder führe `openclaw configure` aus.",
      format:
        "Der KI-Dienst konnte diese Anfrage nicht annehmen. Starte mit /new eine neue Unterhaltung oder wähle in der Control UI ein anderes Modell.",
      rate_limit:
        "Der KI-Dienst benötigt eine kurze Pause. Bitte versuche es in einigen Minuten erneut.",
      overloaded:
        "Der KI-Dienst ist ausgelastet. Bitte versuche es gleich erneut oder wähle ein anderes Modell.",
      billing:
        "Der KI-Dienst hat ein Abrechnungsproblem gemeldet. Prüfe dein Guthaben und die Nutzungslimits, bevor du es erneut versuchst.",
      server_error: "Beim KI-Dienst ist ein Fehler aufgetreten. Bitte versuche es gleich erneut.",
      route_unavailable:
        "Der Anbieter kann dieses Modell gerade nicht bereitstellen. Wähle ein anderes Modell.",
      timeout:
        "Die Anfrage hat zu lange gedauert. Prüfe die Unterhaltung auf bereits abgeschlossene Arbeiten, bevor du es erneut versuchst.",
      tls_certificate:
        "Es konnte keine sichere Verbindung zum KI-Dienst hergestellt werden. Einzelheiten findest du in der Control UI unter Einstellungen → Protokolle oder mit `openclaw logs --follow` im Terminal.",
      context_overflow:
        "Diese Unterhaltung ist für das Modell zu lang. Versuche /compact oder starte mit /new eine neue Unterhaltung.",
      model_not_found:
        "Dieses Modell wurde nicht gefunden. Wähle in der Control UI ein anderes Modell oder führe `openclaw configure` aus.",
      session_expired:
        "Deine KI-Sitzung ist abgelaufen. Starte mit /new eine neue Unterhaltung. Falls das erneut passiert, melde dich in der Control UI unter Modelle an.",
      empty_response:
        "Der KI-Dienst hat eine leere Antwort zurückgegeben. Bitte versuche es erneut.",
      no_error_details: "",
      unclassified: "",
      unknown: "",
    },
    storageFailure: {
      "storage-worker-memory":
        "Dem Speicher-Worker von OpenClaw fehlt Arbeitsspeicher. Bitte den Betreiber, Speicherauslastung und Protokolle zu prüfen. Ein Neustart dieser Sitzung allein behebt das nicht.",
      unavailable:
        "Die Datenbankverbindung wurde getrennt. Dieser Vorgang wurde zurückgerollt und nichts daraus gespeichert. Bitte versuche es erneut.",
      session_actor_reconciliation:
        "OpenClaw konnte die letzte Änderung der Unterhaltung nicht bestätigen. Einige Arbeiten können gespeichert sein. Warte auf laufende Arbeiten und prüfe den Verlauf vor einem neuen Versuch. Falls es weiter scheitert, starte OpenClaw neu.",
      "57014":
        "PostgreSQL hat einen Datenbankvorgang abgebrochen oder dessen Zeitlimit erreicht. Prüfe vor einem neuen Versuch, welche Arbeiten abgeschlossen sind. Bei Wiederholung sollte der Betreiber Zeitlimits und Datenbankaktivität prüfen.",
      SQLITE_BUSY:
        "OpenClaw speichert gerade deine Unterhaltung. Warte einen Moment und prüfe dann die Unterhaltung, bevor du es erneut versuchst.",
      SQLITE_LOCKED:
        "OpenClaw speichert gerade deine Unterhaltung. Warte einen Moment und prüfe dann die Unterhaltung, bevor du es erneut versuchst.",
      SQLITE_FULL:
        "OpenClaw konnte deine Unterhaltung nicht speichern, weil der Datenträger voll ist. Schaffe auf dem Computer, auf dem OpenClaw läuft, freien Speicherplatz, bevor du fortfährst.",
      SQLITE_READONLY:
        "OpenClaw darf deine Unterhaltung nicht speichern. Prüfe die Ordnerberechtigungen auf dem Computer, auf dem OpenClaw läuft.",
      SQLITE_IOERR:
        "OpenClaw konnte deine Unterhaltung nicht speichern. Prüfe den Datenträger auf dem Computer, auf dem OpenClaw läuft, bevor du fortfährst.",
      transcript_writer_fenced:
        "Diese Unterhaltung hat sich geändert, während OpenClaw gearbeitet hat. Prüfe die neuesten Nachrichten, bevor du fortfährst.",
    },
    runtimeCoordinationFailure: {
      child_completion_delivery_failed:
        "Das Ergebnis der untergeordneten Sitzung konnte hier nicht zugestellt werden. Deine Unterhaltung bleibt erhalten. Prüfe dort gespeicherte Arbeiten und versuche es danach erneut.",
      codex_node_disconnected:
        "Die Verbindung zum Codex-Ausführungsknoten wurde getrennt. Starte einen neuen Versuch.",
      node_runner_update_required:
        "Der Geräte-Worker muss aktualisiert werden, bevor er Sitzungen ausführen kann. Führe `openclaw update` aus, verbinde ihn erneut und führe auf einem Knoten ohne Oberfläche `openclaw node restart` aus, bevor du es erneut versuchst.",
      "runner-offline":
        "Der Geräte-Worker ist offline. Verbinde ihn erneut, versuche es später oder hole die Sitzung zurück auf dieses Gateway.",
    },
    voiceControlFailed:
      "OpenClaw konnte diesen Sprachbefehl nicht verarbeiten. Bitte versuche es erneut.",
    voiceInputFailed:
      "OpenClaw konnte diese Spracheingabe nicht verarbeiten. Prüfe die Unterhaltung, bevor du es erneut versuchst.",
    voiceTranscriptionFailed:
      "OpenClaw konnte diese Spracheingabe nicht erkennen. Prüfe die Verbindung und versuche es erneut.",
    voiceConnectionFailed:
      "OpenClaw konnte diese Sprachanfrage nicht abschließen. Prüfe die Verbindung und versuche es erneut.",
    voiceControlQueueFull:
      "Die Warteschlange für Sprachbefehle ist voll. Bitte warte, bis die ausstehenden Befehle abgeschlossen sind, und versuche es dann erneut.",
    voiceNoActiveRun: (action) =>
      action === "cancel"
        ? "Es gibt gerade keinen aktiven OpenClaw-Auftrag zum Abbrechen."
        : "Es gibt gerade keinen aktiven OpenClaw-Auftrag zum Umsteuern.",
    voiceCancelled: "Der aktive OpenClaw-Auftrag wurde abgebrochen.",
    voiceCancelFailed: "OpenClaw konnte den aktiven Auftrag nicht abbrechen.",
    voiceFollowupQueued: "Die Folgeanfrage wurde für den aktiven OpenClaw-Auftrag vorgemerkt.",
    voiceSteered: "Verstanden. Ich habe den aktiven Auftrag entsprechend angepasst.",
    voiceInputUnconfirmed:
      "OpenClaw konnte diese Eingabe nicht bestätigen. Sie wurde nicht erneut gesendet. Prüfe die Unterhaltung, bevor du es erneut versuchst.",
    voiceScopedSteeringUnavailable:
      "Diese Agentenlaufzeit kann den aktiven Auftrag nicht sicher per Sprache anpassen. Frage nach dem Status, brich den Auftrag ab oder stelle eine neue ausdrückliche Anfrage. Aktualisiere die Laufzeit, sobald sie geschützte Eingaben unterstützt.",
    voiceCompacting:
      "OpenClaw verkürzt gerade den Kontext des aktiven Auftrags und kann noch keine Änderungen per Sprache annehmen.",
    voiceNotAcceptingSteering:
      "OpenClaw bearbeitet einen Auftrag, nimmt aber gerade keine Änderungen daran an.",
    voiceFollowupRejected: "OpenClaw konnte diese Folgeanfrage nicht vormerken.",
    voiceSteeringRejected: "OpenClaw konnte den aktiven Auftrag nicht anpassen.",
    voiceLastRequestFinished: "OpenClaw hat die letzte Sprachanfrage abgeschlossen.",
    voiceIdle: "Ich bearbeite gerade keine Anfrage.",
    voiceToolStarting: (name) =>
      name ? `OpenClaw startet ${name}.` : "OpenClaw startet ein Werkzeug.",
    voiceToolFinished: (name) =>
      name
        ? `OpenClaw hat ${name} abgeschlossen und arbeitet weiter.`
        : "OpenClaw hat ein Werkzeug abgeschlossen und arbeitet weiter.",
    voiceToolWorking: (name, phase) =>
      name
        ? `OpenClaw arbeitet mit ${name}${phase ? ` (${phase})` : ""}.`
        : "OpenClaw arbeitet noch.",
    voiceToolRunning: (name) => `OpenClaw führt ${name} aus.`,
    voiceWaitingOnModel: "OpenClaw wartet auf das Modell.",
    voiceWorking: "OpenClaw bearbeitet die aktuelle Sprachanfrage.",
    replyUnavailable:
      "⚠️ OpenClaw konnte diese Anfrage nicht abschließen. Prüfe die Unterhaltung, bevor du es erneut versuchst. Einzelheiten findest du in der Control UI unter Einstellungen → Protokolle oder mit `openclaw logs --follow`.",
    replyRestarting:
      "⚠️ Das Gateway wird neu gestartet. Bitte warte einige Sekunden und versuche es erneut.",
    replyConversationChanged:
      "⚠️ Diese Unterhaltung hat sich geändert, bevor deine Nachricht bearbeitet werden konnte. Prüfe die neuesten Nachrichten und versuche es bei Bedarf erneut.",
    replyEmpty:
      "Ich habe den Durchlauf beendet, aber dabei ist keine sichtbare Antwort entstanden. Bitte versuche es erneut oder starte eine neue Sitzung, falls das weiterhin passiert.",
    replyWorkerTimeout:
      "Ein lokaler Arbeitsauftrag hat das Zeitlimit überschritten. Bitte versuche es erneut.",
    replyQueueFull:
      "Diese Nachricht wurde nicht vorgemerkt, weil die Warteschlange der Sitzung voll ist. Bitte warte, bis die aktuelle Antwort abgeschlossen ist, und versuche es dann erneut.",
    replyWriterFenceBlocked:
      "⚠️ Der vorherige Lauf konnte nicht sicher beendet werden, weil sein Schreibzugriff noch aktiv ist. Starte eine separate Sitzung oder starte das Gateway neu, bevor du es in dieser Sitzung erneut versuchst.",
    replyQueueFullNoRetry:
      "Diese Nachricht wurde nicht eingereiht, weil die Warteschlange der Sitzung voll ist.",
    replyMissing:
      "Es wurde keine Antwort zurückgegeben. Frage erneut, wenn du noch eine Antwort benötigst.",
    replyMissingSideEffect:
      "Es wurde keine Antwort zurückgegeben. Frage erneut, wenn du noch eine Antwort benötigst. Hinweis: Einige Werkzeugaktionen können bereits ausgeführt worden sein. Bitte prüfe das vor einem erneuten Versuch.",
    replyRateLimited:
      "⚠️ Dieser Lauf wurde wegen der Anfragelimits des Modellanbieters angehalten. Bitte versuche es in wenigen Minuten erneut.",
    replyMediaContinuing:
      "Ich arbeite weiter daran und schicke dir das Ergebnis, sobald es fertig ist.",
    replyShuttingDown:
      "⚠️ Der vorherige Auftrag wird noch beendet. Bitte versuche es gleich erneut.",
    replyStalled:
      "⚠️ Dieser Auftrag wurde unterbrochen, weil er keine Fortschritte mehr machte. Bitte versuche es erneut.",
    replyNoVisible:
      "⚠️ OpenClaw konnte keine Antwort erzeugen oder zustellen. Bitte versuche es erneut. Falls das weiterhin passiert, bitte den Betreiber, die Gateway-Protokolle zu prüfen.",
    replyReference: (reference) => `Referenz: ${reference}.`,
    replyDetailsHint:
      "Einzelheiten findest du in der Control UI unter Einstellungen → Protokolle oder mit `openclaw logs --follow` im Terminal.",
    replyTaskIncomplete:
      "⚠️ Der Auftrag konnte nicht abgeschlossen werden. Einige Aktionen wurden möglicherweise ausgeführt. Prüfe ihre Ergebnisse, bevor du fortfährst.",
    replyFinishFailed: "OpenClaw konnte diese Antwort nicht abschließen.",
    voiceActionNotExecuted: (toolName) =>
      `Die folgenreiche Sprachaktion "${toolName}" wurde nicht ausgeführt.`,
    voiceConfirmationRequest:
      'Bitte den Benutzer, mit "ja" diese Aktion zu bestätigen oder mit "nein" abzubrechen.',
    voiceConfirmationPending:
      'Eine ausstehende Aktion wurde noch nicht ausgeführt. Sage "ja", um diese Aktion zu bestätigen, oder "nein", um sie abzubrechen.',
    voiceConfirmationNoLongerCurrent:
      "Eine Aktion aus dieser Anfrage wurde nicht ausgeführt, weil ihre gesprochene Bestätigung nicht mehr gültig ist. Stelle eine neue Anfrage, wenn du sie weiterhin ausführen möchtest.",
  },
};

export function resolveUserMessages(language?: string): Readonly<UserMessages> {
  return catalogs[resolveUserMessageLocale(language)];
}
