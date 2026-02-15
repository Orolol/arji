export function selectOnlyTicket(ticketId: string) {
  return [ticketId];
}

export function toggleTicketSelection(
  selectedTicketIds: string[],
  ticketId: string
) {
  if (selectedTicketIds.includes(ticketId)) {
    return selectedTicketIds.filter((id) => id !== ticketId);
  }

  return [...selectedTicketIds, ticketId];
}

export function getActiveDetailTicketId(selectedTicketIds: string[]) {
  return selectedTicketIds[0] ?? null;
}
