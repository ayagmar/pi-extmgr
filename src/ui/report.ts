/**
 * Shared report presenter.
 *
 * Long-form informational output (help, item details, history, trash lists,
 * profile check results) renders as a scrollable floating overlay in the full
 * TUI so it never pollutes the chat transcript. Dialog-only and
 * non-interactive modes keep the plain notification path.
 */
import {
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  type KeybindingsManager,
  matchesKey,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { hasCustomUI } from "../utils/mode.js";
import { type NotifyLevel, notify } from "../utils/notify.js";

type AnyContext = ExtensionCommandContext | ExtensionContext;

export interface ReportOptions {
  title: string;
  lines: string[];
  level?: NotifyLevel;
}

/** Rows reserved for the report chrome: title, rules, and footer hint. */
const PANEL_CHROME_ROWS = 5;
const MIN_VIEWPORT_ROWS = 4;

export class ReportPanel {
  focused = false;
  private scrollOffset = 0;

  constructor(
    private readonly tui: Pick<TUI, "requestRender"> & {
      terminal: { rows: number };
    },
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly title: string,
    private readonly lines: string[],
    private readonly done: () => void,
    private readonly level: NotifyLevel = "info"
  ) {}

  invalidate(): void {
    // Stateless rendering; nothing cached between renders.
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      this.keybindings.matches(data, "tui.select.confirm") ||
      data === "q"
    ) {
      this.done();
      return;
    }

    const page = Math.max(1, this.lastViewportRows - 1);
    let nextOffset = this.scrollOffset;
    if (this.keybindings.matches(data, "tui.select.up")) nextOffset -= 1;
    else if (this.keybindings.matches(data, "tui.select.down")) nextOffset += 1;
    else if (this.keybindings.matches(data, "tui.select.pageUp")) nextOffset -= page;
    else if (this.keybindings.matches(data, "tui.select.pageDown")) nextOffset += page;
    else if (matchesKey(data, Key.home)) nextOffset = 0;
    else if (matchesKey(data, Key.end)) nextOffset = Number.MAX_SAFE_INTEGER;
    else return;

    // Render clamps against the wrapped line count for the current width.
    this.scrollOffset = Math.max(0, nextOffset);
    this.tui.requestRender();
  }

  private lastViewportRows = MIN_VIEWPORT_ROWS;

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const contentWidth = Math.max(1, safeWidth - 4);
    const wrapped = this.lines.flatMap((line) =>
      line === "" ? [""] : wrapTextWithAnsi(line, contentWidth)
    );

    const viewportRows = Math.max(
      MIN_VIEWPORT_ROWS,
      Math.min(wrapped.length, this.tui.terminal.rows - PANEL_CHROME_ROWS - 2)
    );
    this.lastViewportRows = viewportRows;
    const maxOffset = Math.max(0, wrapped.length - viewportRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const titleColor =
      this.level === "error" ? "error" : this.level === "warning" ? "warning" : "accent";
    const rule = this.theme.fg("borderMuted", "─".repeat(safeWidth));
    const visible = wrapped.slice(this.scrollOffset, this.scrollOffset + viewportRows);
    const scrollHint =
      maxOffset > 0
        ? `${this.scrollOffset + 1}-${this.scrollOffset + visible.length} of ${wrapped.length} · ↑↓ scroll · `
        : "";

    const out: string[] = [
      truncateToWidth(` ${this.theme.fg(titleColor, this.theme.bold(this.title))}`, safeWidth, ""),
      rule,
    ];
    for (const line of visible) {
      out.push(truncateToWidth(`  ${line}`, safeWidth, ""));
    }
    for (let i = visible.length; i < viewportRows; i++) out.push("");
    out.push(rule, truncateToWidth(this.theme.fg("dim", ` ${scrollHint}Esc close`), safeWidth, ""));
    return out;
  }
}

/**
 * Present a multi-line report. Uses a floating scrollable overlay when the
 * full TUI is available, otherwise falls back to a single notification.
 */
export async function showReport(ctx: AnyContext, options: ReportOptions): Promise<void> {
  if (!hasCustomUI(ctx)) {
    notify(ctx, `${options.title}:\n${options.lines.join("\n")}`, options.level ?? "info");
    return;
  }

  const outcome = await ctx.ui.custom<"closed" | undefined>(
    (tui, theme, keybindings, done) =>
      new ReportPanel(
        tui,
        theme,
        keybindings,
        options.title,
        options.lines,
        () => done("closed"),
        options.level ?? "info"
      ),
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-right",
        width: "55%",
        minWidth: 46,
        margin: 1,
      },
    }
  );

  // A degraded custom UI resolves undefined without showing the panel; keep
  // the content reachable through a plain notification.
  if (outcome === undefined) {
    notify(ctx, `${options.title}:\n${options.lines.join("\n")}`, options.level ?? "info");
  }
}

/**
 * Present a titled list. Empty lists produce a short notification instead of
 * an empty panel.
 */
export async function showListReport(
  ctx: AnyContext,
  title: string,
  items: string[]
): Promise<void> {
  if (items.length === 0) {
    notify(ctx, `No ${title.toLowerCase()} found.`, "info");
    return;
  }

  await showReport(ctx, { title, lines: items });
}
