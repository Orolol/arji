"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";

interface NamedAgentSelectProps {
  value: string | null;
  onChange: (namedAgentId: string) => void;
  disabled?: boolean;
  className?: string;
}

export function NamedAgentSelect({
  value,
  onChange,
  disabled = false,
  className,
}: NamedAgentSelectProps) {
  const { agents, loading } = useNamedAgentsList();

  if (loading) {
    return (
      <Select disabled>
        <SelectTrigger className={className ?? "w-44 h-7 text-xs"}>
          <SelectValue placeholder="Loading..." />
        </SelectTrigger>
      </Select>
    );
  }

  if (agents.length === 0) {
    return (
      <Select disabled>
        <SelectTrigger className={className ?? "w-44 h-7 text-xs"}>
          <SelectValue placeholder="No agents configured" />
        </SelectTrigger>
      </Select>
    );
  }

  return (
    <Select
      value={value ?? undefined}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger className={className ?? "w-44 h-7 text-xs"}>
        <SelectValue placeholder="Select agent" />
      </SelectTrigger>
      <SelectContent>
        {agents.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            {agent.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
