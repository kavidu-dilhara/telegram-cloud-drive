import { type ReactNode, useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Clicking outside closes the dialog (default). Turn off where typed text would be lost. */
  closeOnBackdrop?: boolean;
}

/** Accessible dialog: labelled, focus is trapped and restored, Escape and backdrop click close it. */
export function Modal({ title, onClose, children, footer, wide, closeOnBackdrop = true }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const initial = dialog?.querySelector<HTMLElement>("[data-autofocus]") ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog;
    initial?.focus();
    document.body.classList.add("modal-open");

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab" && dialog) {
        const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("modal-open");
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => closeOnBackdrop && event.target === event.currentTarget && onClose()}
    >
      <div
        className={wide ? "modal modal-wide" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>
  );
}
