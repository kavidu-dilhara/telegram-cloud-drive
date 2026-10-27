import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Copy, Send } from "lucide-react";
import { Modal } from "./Modal";
import { shareViaTelegram } from "../telegram";
import type { FolderOption } from "../utils";
import { useToast } from "./Toasts";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}
interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  suffix?: string;
  hint?: string;
  confirmLabel?: string;
}
interface FolderPickOptions {
  title: string;
  message?: string;
  options: FolderOption[];
  initial?: string | null;
  confirmLabel: string;
}
interface LinkOptions {
  title: string;
  url: string;
  text: string;
}

type Request =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void }
  | { kind: "folder"; options: FolderPickOptions; resolve: (value: { id: string | null } | null) => void }
  | { kind: "link"; options: LinkOptions; resolve: () => void };

interface DialogApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  pickFolder: (options: FolderPickOptions) => Promise<{ id: string | null } | null>;
  showLink: (options: LinkOptions) => Promise<void>;
}

const DialogContext = createContext<DialogApi | null>(null);
export const useDialogs = () => {
  const value = useContext(DialogContext);
  if (!value) throw new Error("useDialogs must be used inside DialogProvider");
  return value;
};

/** Copies text and tells the user whether it worked (clipboard access is blocked in some webviews). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The answer a caller gets when its dialog is replaced by another one: the same as pressing Cancel. */
function cancelRequest(request: Request) {
  if (request.kind === "confirm") request.resolve(false);
  else if (request.kind === "link") request.resolve();
  else request.resolve(null);
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const current = useRef<Request | null>(null);
  const [sequence, setSequence] = useState(0);

  const api = useMemo<DialogApi>(() => {
    // Opening a dialog while another is open cancels the first one, so its caller is never left waiting forever.
    const open = (next: Request) => {
      const previous = current.current;
      current.current = next;
      setSequence((count) => count + 1); // a new dialog never inherits what was typed into the previous one
      setRequest(next);
      if (previous) cancelRequest(previous);
    };
    return {
      confirm: (options) => new Promise((resolve) => open({ kind: "confirm", options, resolve })),
      prompt: (options) => new Promise((resolve) => open({ kind: "prompt", options, resolve })),
      pickFolder: (options) => new Promise((resolve) => open({ kind: "folder", options, resolve })),
      showLink: (options) => new Promise((resolve) => open({ kind: "link", options, resolve })),
    };
  }, []);

  const close = useCallback(() => {
    current.current = null;
    setRequest(null);
  }, []);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {request?.kind === "confirm" && <ConfirmDialog request={request} close={close} />}
      {request?.kind === "prompt" && <PromptDialog key={sequence} request={request} close={close} />}
      {request?.kind === "folder" && <FolderDialog request={request} close={close} />}
      {request?.kind === "link" && <LinkDialog request={request} close={close} />}
    </DialogContext.Provider>
  );
}

function ConfirmDialog(
  { request, close }: { request: Extract<Request, { kind: "confirm" }>; close: () => void },
) {
  const { options, resolve } = request;
  const finish = (value: boolean) => {
    resolve(value);
    close();
  };
  return (
    <Modal
      title={options.title}
      onClose={() => finish(false)}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={() => finish(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            data-autofocus
            className={options.danger ? "btn btn-danger-solid" : "btn btn-primary"}
            onClick={() => finish(true)}
          >
            {options.confirmLabel ?? "Confirm"}
          </button>
        </>
      }
    >
      <p className="modal-text">{options.message}</p>
    </Modal>
  );
}

function PromptDialog(
  { request, close }: { request: Extract<Request, { kind: "prompt" }>; close: () => void },
) {
  const { options, resolve } = request;
  const [value, setValue] = useState(options.initial ?? "");
  const finish = (result: string | null) => {
    resolve(result);
    close();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) finish(value.trim());
  };
  return (
    <Modal title={options.title} onClose={() => finish(null)} closeOnBackdrop={false}>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>{options.label}</span>
          <span className="input-suffix">
            <input
              data-autofocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={255}
              required
            />
            {options.suffix && <span className="suffix" aria-hidden="true">{options.suffix}</span>}
          </span>
        </label>
        {options.hint && <p className="hint">{options.hint}</p>}
        <div className="modal-actions inline">
          <button type="button" className="btn" onClick={() => finish(null)}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
            {options.confirmLabel ?? "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FolderDialog(
  { request, close }: { request: Extract<Request, { kind: "folder" }>; close: () => void },
) {
  const { options, resolve } = request;
  const [selected, setSelected] = useState<string>(options.initial ?? "");
  const finish = (result: { id: string | null } | null) => {
    resolve(result);
    close();
  };
  return (
    <Modal
      title={options.title}
      onClose={() => finish(null)}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={() => finish(null)}
          >
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => finish({ id: selected || null })}>
            {options.confirmLabel}
          </button>
        </>
      }
    >
      {options.message && <p className="modal-text">{options.message}</p>}
      <label className="field">
        <span>Destination folder</span>
        <select data-autofocus value={selected} onChange={(event) => setSelected(event.target.value)}>
          {options.options.map((option) => (
            <option key={option.id ?? "root"} value={option.id ?? ""}>{option.label}</option>
          ))}
        </select>
      </label>
    </Modal>
  );
}

function LinkDialog({ request, close }: { request: Extract<Request, { kind: "link" }>; close: () => void }) {
  const { options, resolve } = request;
  const toast = useToast();
  const finish = () => {
    resolve();
    close();
  };
  const copy = async () =>
    toast(
      (await copyText(options.url))
        ? "Link copied"
        : "Copy is blocked here. Select the link and copy it manually.",
      { kind: "info" },
    );
  return (
    <Modal
      title={options.title}
      onClose={finish}
      footer={<button type="button" className="btn btn-primary" onClick={finish}>Done</button>}
    >
      <p className="modal-text">
        Anyone with this link can receive the file from your bot. Revoke it any time in Shared.
      </p>
      <input
        className="link-box"
        readOnly
        value={options.url}
        aria-label="Share link"
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="button-row">
        <button type="button" className="btn" onClick={() => void copy()}>
          <Copy size={16} aria-hidden="true" /> Copy link
        </button>
        <button type="button" className="btn" onClick={() => shareViaTelegram(options.url, options.text)}>
          <Send size={16} aria-hidden="true" /> Send in Telegram
        </button>
      </div>
    </Modal>
  );
}
