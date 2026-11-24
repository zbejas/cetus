import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Command,
  FolderSync,
  Home,
  Layers,
  Moon,
  Plus,
  ScrollText,
  Search,
  Server,
  Settings,
  Sun,
} from "lucide-react";
import { Dialog } from "./ui";
import { useMe, useScanStacks, useStacks } from "../lib/queries";
import { useToast } from "./Toast";
import { can } from "../lib/api";
import { cn } from "../lib/format";

const navigation = [
  { label: "Overview", path: "/", icon: Home },
  { label: "Stacks", path: "/stacks", icon: Layers },
  { label: "Logs", path: "/logs", icon: ScrollText },
  { label: "Hosts", path: "/hosts", icon: Server },
  { label: "Activity", path: "/activity", icon: Activity },
  { label: "Settings", path: "/settings", icon: Settings },
];

export function CommandPalette({
  open,
  onClose,
  onToggleTheme,
}: {
  open: boolean;
  onClose: () => void;
  onToggleTheme: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const stacks = useStacks();
  const scan = useScanStacks();
  const me = useMe();
  const canWrite = can(me.data?.actor.scopes, "stacks:write");
  const toast = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open]);

  const filteredStacks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return (stacks.data ?? []).slice(0, 6);
    return (stacks.data ?? []).filter((stack) =>
      `${stack.displayName} ${stack.name} ${stack.hostName} ${stack.tags.join(" ")}`.toLowerCase().includes(q),
    ).slice(0, 8);
  }, [query, stacks.data]);

  const filteredNav = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return navigation;
    return navigation.filter((item) => item.label.toLowerCase().includes(q));
  }, [query]);

  const commands = useMemo(() => {
    const q = query.trim().toLowerCase();
    const writableActions = [
      {
        label: "New stack",
        hint: "Create",
        icon: Plus,
        run: () => {
          onClose();
          window.dispatchEvent(new CustomEvent("cetus:new-stack"));
        },
      },
      {
        label: "Scan stacks folder",
        hint: "Refresh",
        icon: FolderSync,
        run: () => {
          scan.mutate(undefined, {
            onSuccess: (result) => toast.success("Folder scanned", `${result.count} stacks indexed.`),
            onError: (error) => toast.error("Scan failed", error instanceof Error ? error.message : "Unknown error"),
          });
          onClose();
        },
      },
    ];
    const actions = [
      ...(canWrite ? writableActions : []),
      {
        label: "Toggle theme",
        hint: "Appearance",
        icon: document.documentElement.classList.contains("light") ? Moon : Sun,
        run: () => {
          onToggleTheme();
          onClose();
        },
      },
    ];
    if (!q) return actions;
    return actions.filter((action) => action.label.toLowerCase().includes(q));
  }, [canWrite, onClose, onToggleTheme, query, scan, toast]);

  const allItems = [
    ...filteredNav.map((item) => ({
      kind: "nav" as const,
      key: `nav-${item.path}`,
      label: item.label,
      hint: "Navigate",
      icon: item.icon,
      run: () => {
        onClose();
        navigate({ to: item.path });
      },
    })),
    ...filteredStacks.map((stack) => ({
      kind: "stack" as const,
      key: `stack-${stack.id}`,
      label: stack.displayName,
      hint: `${stack.hostName} · ${stack.status}`,
      icon: Layers,
      run: () => {
        onClose();
        navigate({ to: "/stacks/$stackId", params: { stackId: stack.id } });
      },
    })),
    ...commands.map((command) => ({
      kind: "action" as const,
      key: `action-${command.label}`,
      label: command.label,
      hint: command.hint,
      icon: command.icon,
      run: command.run,
    })),
  ];

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(allItems.length - 1, 0)));
  }, [allItems.length]);

  return (
    <Dialog open={open} onClose={onClose} title="Command palette" className="command-palette">
      <div style={{ position: "relative" }}>
        <Search size={16} style={{ position: "absolute", left: 12, top: 12, color: "var(--muted)" }} />
        <input
          ref={inputRef}
          className="command-input"
          style={{ paddingLeft: 36 }}
          placeholder="Search stacks, pages, and actions..."
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((current) => Math.min(current + 1, allItems.length - 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current) => Math.max(current - 1, 0));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              allItems[active]?.run();
            }
          }}
        />
      </div>
      <div className="command-list">
        {filteredNav.length > 0 ? <div className="command-group">Navigate</div> : null}
        {allItems.map((item, index) => (
          <button
            key={item.key}
            className="command-item"
            data-active={index === active}
            onMouseEnter={() => setActive(index)}
            onClick={item.run}
          >
            <item.icon size={15} />
            <span>{item.label}</span>
            <small>{item.hint}</small>
            {index === active ? <ArrowRight size={13} /> : <span style={{ width: 13 }} />}
          </button>
        ))}
        {allItems.length === 0 ? (
          <div className="empty-state" style={{ padding: "28px 12px" }}>
            <div className="empty-state-icon"><Search size={18} /></div>
            <h3>Nothing matches</h3>
            <p>Try a stack name, a host, or an action.</p>
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px 2px", color: "var(--muted)", fontSize: 11 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Command size={12} /> K</span>
        <span>to open</span>
        <span style={{ marginLeft: "auto" }}>Enter to run</span>
      </div>
    </Dialog>
  );
}
