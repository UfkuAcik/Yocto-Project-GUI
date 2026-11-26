import * as Dialog from "@radix-ui/react-dialog";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { X } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  className,
  variant = "secondary",
  size = "md",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}) {
  const variants: Record<ButtonVariant, string> = {
    primary:
      "bg-accent text-slate-950 font-semibold hover:brightness-110 border border-transparent shadow-sm",
    secondary:
      "bg-elevated text-fg hover:bg-border/60 border border-border",
    ghost: "bg-transparent text-muted hover:text-fg hover:bg-elevated border border-transparent",
    danger: "bg-danger/15 text-danger hover:bg-danger/25 border border-danger/40 font-medium",
  };
  const sizes = {
    sm: "h-7 px-2.5 text-xs gap-1.5",
    md: "h-8 px-3 text-xs gap-1.5",
  };
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  );
}

type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger";

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: "bg-elevated text-muted border-border",
    accent: "bg-accent/15 text-accent border-accent/35",
    ok: "bg-success/15 text-success border-success/35",
    warn: "bg-warning/15 text-warning border-warning/35",
    danger: "bg-danger/15 text-danger border-danger/35",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium border leading-tight",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-surface p-4", className)}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-8 w-full rounded-md border border-border bg-bg px-2.5 text-xs text-fg placeholder:text-muted/70 focus:outline-none focus:border-accent",
        className
      )}
      {...props}
    />
  );
}

export function ProgressBar({
  value,
  tone = "accent",
  className,
}: {
  value: number;
  tone?: "accent" | "ok" | "warn" | "danger";
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const fills = {
    accent: "bg-accent",
    ok: "bg-success",
    warn: "bg-warning",
    danger: "bg-danger",
  };
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-elevated border border-border/60", className)}>
      <div
        className={cn("h-full transition-all duration-200", fills[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border transition-colors",
        checked ? "bg-accent" : "bg-elevated"
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4.5" : "translate-x-0.5"
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/65 backdrop-blur-[1px]" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-4 shadow-2xl focus:outline-none",
            wide ? "w-[min(92vw,960px)] max-h-[85vh] flex flex-col" : "w-[min(92vw,560px)]"
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
            <div>
              <Dialog.Title className="text-sm font-semibold text-fg">{title}</Dialog.Title>
              {subtitle && <p className="mt-0.5 text-xs text-muted mono-num">{subtitle}</p>}
            </div>
            <Dialog.Close className="rounded p-1 text-muted hover:bg-elevated hover:text-fg cursor-pointer">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="mt-3 flex-1 overflow-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
