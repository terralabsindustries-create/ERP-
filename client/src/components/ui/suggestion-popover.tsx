import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";

const stopPropagation = (e: Event) => e.stopPropagation();

/** How many matches a type-ahead list shows; the list scrolls past its max height. */
export const MAX_SUGGESTIONS = 50;

interface SuggestionPopoverProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  onSelect: (item: T) => void;
  /** Shown instead of the list when there are no items. Leave out to hide the popover then. */
  empty?: React.ReactNode;
  /** Pinned below the list (outside its scroll area), e.g. an "add new" action. */
  footer?: React.ReactNode;
  /** The text input the suggestions belong to. */
  children: React.ReactElement;
  listLabel?: string;
  className?: string;
  itemClassName?: string;
}

/**
 * Type-ahead suggestions for a text input — inventory items, customers.
 *
 * Long forms live in dialogs that scroll (`overflow-y-auto`). A list
 * positioned `absolute` inside one is clipped at the dialog's edge, and a
 * wheel or trackpad gesture that reaches the end of the list scrolls the
 * dialog instead. This list is portalled out of the dialog, opens above or
 * below the input wherever there is room, is never taller than that room, and
 * contains its own scrolling.
 *
 * Focus stays in the input throughout: ArrowUp / ArrowDown move the
 * highlight, Enter picks it (only when something is highlighted, so Enter on
 * a typed custom value still moves to the next field), Escape closes.
 */
export function SuggestionPopover<T>({
  open,
  onOpenChange,
  items,
  getKey,
  renderItem,
  onSelect,
  empty,
  footer,
  children,
  listLabel = "Suggestions",
  className,
  itemClassName,
}: SuggestionPopoverProps<T>) {
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // A modal dialog locks scrolling with a document-level wheel/touchmove
  // listener that cancels any gesture it cannot trace to inside the dialog —
  // and this list is portalled outside it, so the list would not scroll at
  // all. Stopping those events at the list keeps them from that listener; the
  // list scrolls natively and `overscroll-contain` keeps the gesture there.
  const setListRef = React.useCallback((node: HTMLDivElement | null) => {
    const previous = listRef.current;
    if (previous) {
      previous.removeEventListener("wheel", stopPropagation);
      previous.removeEventListener("touchmove", stopPropagation);
    }
    listRef.current = node;
    if (node) {
      node.addEventListener("wheel", stopPropagation, { passive: true });
      node.addEventListener("touchmove", stopPropagation, { passive: true });
    }
  }, []);
  const listId = React.useId();
  const [active, setActive] = React.useState(-1);

  const shown = open && (items.length > 0 || empty != null || footer != null);

  // A new set of matches (or reopening) starts with nothing highlighted.
  const signature = items.map(getKey).join("\u0000");
  React.useEffect(() => {
    setActive(-1);
  }, [signature, shown]);

  // Keep the highlighted row visible inside the list (only the list scrolls).
  React.useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }, [active]);

  // The list follows the input when the form behind it scrolls. Once the
  // input is scrolled out of view, close the list rather than leave it
  // floating over other fields. (A scroll that keeps the input visible — the
  // browser bringing a focused field into view, say — leaves it open.)
  React.useEffect(() => {
    if (!shown) return;
    const onScroll = (e: Event) => {
      const target = e.target;
      const anchor = anchorRef.current;
      if (!anchor || !(target instanceof Node) || listRef.current?.contains(target) || !target.contains(anchor)) return;
      const view = target instanceof Element ? target.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const input = anchor.getBoundingClientRect();
      if (input.top < view.top || input.bottom > view.bottom) onOpenChange(false);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [shown, onOpenChange]);

  const choose = (item: T) => {
    onSelect(item);
    onOpenChange(false);
  };

  // Capture phase: runs before the input's own handlers and before the
  // form's Enter-moves-focus handler, which a pick must not trigger.
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown) {
        onOpenChange(true);
        return;
      }
      if (items.length === 0) return;
      const down = e.key === "ArrowDown";
      setActive((i) => (down ? (i + 1) % items.length : i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === "Enter" && shown && active >= 0 && active < items.length) {
      e.preventDefault();
      e.stopPropagation();
      choose(items[active]);
    }
  };

  const optionId = (i: number) => `${listId}-option-${i}`;
  const input = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-expanded": shown,
        "aria-controls": shown ? listId : undefined,
        "aria-activedescendant": shown && active >= 0 ? optionId(active) : undefined,
      })
    : children;

  return (
    <PopoverPrimitive.Root open={shown} onOpenChange={(next) => !next && onOpenChange(false)}>
      <PopoverPrimitive.Anchor asChild>
        <div ref={anchorRef} onKeyDownCapture={onKeyDownCapture}>
          {input}
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          // The popup is the listbox inside, not a dialog of its own.
          role="presentation"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          // The input keeps focus: nothing in the list takes it on open,
          // close or click.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          // Clicking back into the input is not "outside".
          onInteractOutside={(e) => {
            if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
          }}
          className={cn(
            "z-50 flex max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md outline-none",
            className
          )}
          style={{
            width: "var(--radix-popover-trigger-width)",
            maxHeight: "min(20rem, var(--radix-popover-content-available-height))",
          }}
        >
          <div
            ref={setListRef}
            id={listId}
            role="listbox"
            aria-label={listLabel}
            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          >
            {items.length === 0
              ? empty
              : items.map((item, i) => (
                  <div
                    key={getKey(item)}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    data-active={i === active}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => choose(item)}
                    className={cn(
                      "cursor-pointer select-none rounded-sm px-2 py-1.5 text-left text-sm data-[active=true]:bg-accent data-[active=true]:text-accent-foreground",
                      itemClassName
                    )}
                  >
                    {renderItem(item)}
                  </div>
                ))}
          </div>
          {footer && <div className="shrink-0 border-t">{footer}</div>}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
