import { type CSSProperties, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreVertical } from "lucide-react";
import { cx } from "../utils";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  hidden?: boolean;
  onSelect: () => void;
}

interface PopupMenuProps {
  label: string;
  items: MenuItem[];
  trigger?: ReactNode;
  className?: string;
}

const MENU_WIDTH = 210;

/** Menu rendered in a portal with fixed positioning, so no scrolling or clipping container can cut it off. */
export function PopupMenu({ label, items, trigger, className }: PopupMenuProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const [sheet, setSheet] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const visible = items.filter((item) => !item.hidden);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) return close();
    const rect = buttonRef.current!.getBoundingClientRect();
    const mobile = window.matchMedia("(max-width: 620px)").matches;
    setSheet(mobile);
    if (!mobile) {
      const height = visible.length * 42 + 14;
      const below = rect.bottom + 6 + height <= window.innerHeight - 8;
      setStyle({
        position: "fixed",
        width: MENU_WIDTH,
        left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
        top: below ? rect.bottom + 6 : Math.max(8, rect.top - height - 6),
      });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    const dismiss = () => setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    // A floating menu is positioned against its button, so it closes on scroll; the bottom sheet is pinned and has a scrim instead.
    if (!sheet) {
      window.addEventListener("resize", dismiss);
      window.addEventListener("scroll", dismiss, true);
    }
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open, sheet]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const nodes = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      nodes[(index + 1) % nodes.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      nodes[(index - 1 + nodes.length) % nodes.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      nodes[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      nodes.at(-1)?.focus();
    } else if (event.key === "Tab") close(false);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cx("menu-trigger", className)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
      >
        {trigger ?? <MoreVertical size={18} aria-hidden="true" />}
      </button>
      {open && createPortal(
        <>
          {sheet && <div className="menu-scrim" aria-hidden="true" onClick={() => close(false)} />}
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className={cx("menu-popover", sheet && "menu-sheet")}
            style={sheet ? undefined : style}
            onKeyDown={onKeyDown}
          >
            {visible.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={cx("menu-item", item.danger && "danger")}
                onClick={() => {
                  close(false);
                  item.onSelect();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
