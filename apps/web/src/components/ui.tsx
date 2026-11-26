import { useEffect, useRef } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, LoaderCircle, X } from "lucide-react";
import { cn } from "../lib/format";

type ButtonVariant = "default" | "primary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

export function Button({
  variant = "default",
  size = "md",
  loading = false,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) {
  return (
    <button
      className={cn(
        "btn",
        variant === "primary" && "btn-primary",
        variant === "ghost" && "btn-ghost",
        variant === "danger" && "btn-danger",
        size === "sm" && "btn-sm",
        size === "lg" && "btn-lg",
        className,
      )}
      {...props}
      disabled={props.disabled || loading}
    >
      {loading ? <LoaderCircle size={14} className="animate-spin" /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button className={cn("icon-btn", className)} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("input", className)} {...props} />;
}

export function Badge({
  tone = "default",
  className,
  children,
}: {
  tone?: "default" | "accent" | "success" | "warn" | "danger" | "info";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "badge",
        tone === "accent" && "badge-accent",
        tone === "success" && "badge-success",
        tone === "warn" && "badge-warn",
        tone === "danger" && "badge-danger",
        tone === "info" && "badge-info",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn("skeleton", className)} style={style} />;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50],
  itemLabel = "item",
  ariaLabel,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  itemLabel?: string;
  ariaLabel?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(1, page), pageCount);
  const first = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const last = Math.min(currentPage * pageSize, total);

  return (
    <nav className="pagination" aria-label={ariaLabel ?? `${itemLabel} pagination`}>
      <span className="pagination-range" aria-live="polite">
        {total === 0 ? `0 ${pluralize(total, itemLabel)}` : `${first}-${last} of ${total} ${pluralize(total, itemLabel)}`}
      </span>
      <div className="pagination-controls">
        {onPageSizeChange ? (
          <select
            className="select pagination-size"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label="Rows per page"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>{option} / page</option>
            ))}
          </select>
        ) : null}
        <IconButton label="First page" onClick={() => onPageChange(1)} disabled={currentPage === 1}>
          <ChevronsLeft size={14} />
        </IconButton>
        <IconButton label="Previous page" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1}>
          <ChevronLeft size={14} />
        </IconButton>
        <span className="pagination-page">Page {currentPage} of {pageCount}</span>
        <IconButton label="Next page" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === pageCount}>
          <ChevronRight size={14} />
        </IconButton>
        <IconButton label="Last page" onClick={() => onPageChange(pageCount)} disabled={currentPage === pageCount}>
          <ChevronsRight size={14} />
        </IconButton>
      </div>
    </nav>
  );
}

function pluralize(count: number, singular: string) {
  return count === 1 ? singular : `${singular}s`;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `dialog-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cn("dialog", wide && "dialog-wide", className)}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-header">
        <h3 id={titleId}>{title}</h3>
        <IconButton label="Close dialog" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="dialog-body">{children}</div>
      {footer ? <div className="dialog-footer">{footer}</div> : null}
    </dialog>
  );
}
