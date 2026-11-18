/**
 * A calendar event's attendees, and which of them are the customer's people.
 * Account teams often have addresses at the customer's domain too; such an
 * address is the same person as another attendee (a "twin"), not a customer.
 */

export type Attendee = Readonly<{ email?: string; name?: string; status?: string; organizer?: boolean }>;

export function attendeesOf(value: unknown): Attendee[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Attendee[] => {
    if (typeof item === "string") return item.trim() ? [{ email: item.trim() }] : [];
    if (!item || typeof item !== "object") return [];
    const a = item as Record<string, unknown>;
    const email = typeof a.email === "string" ? a.email : undefined;
    const name = typeof a.displayName === "string" && a.displayName ? a.displayName : typeof a.name === "string" && a.name ? a.name : undefined;
    if (!email && !name) return [];
    return [{ ...(email && { email }), ...(name && { name }), ...(typeof a.responseStatus === "string" && { status: a.responseStatus }), ...(a.organizer === true && { organizer: true }) }];
  });
}

const letters = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");

/** Ways a person's address is commonly spelled, from their name (`dane.isburgh` → daneisburgh, disburgh, danei, isburghd, …). */
function spellings(person: Attendee): Set<string> {
  const names = [person.name ?? "", (person.email ?? "").split("@")[0]!.replace(/\+.*$/, "")]
    .map((text) => text.split(/[\s._-]+/).map(letters).filter(Boolean))
    .filter((parts) => parts.length >= 2);
  const out = new Set<string>();
  for (const parts of names) {
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;
    for (const spelled of [first + last, last + first, first[0] + last, first + last[0], last + first[0]]) if (spelled.length >= 5) out.add(spelled);
  }
  return out;
}

/** The other attendee (outside the customer's domains) the same person is, by name or how their address is spelled. */
export function twinOf(person: Attendee, others: readonly Attendee[]): string | undefined {
  const local = letters((person.email ?? "").split("@")[0]!.replace(/\+.*$/, ""));
  const name = person.name ? letters(person.name) : "";
  const mine = spellings(person);
  const found = others.find((other) => {
    if (name && other.name && letters(other.name) === name) return true;
    const theirs = spellings(other);
    return (local.length >= 5 && theirs.has(local)) || [...mine].some((spelled) => theirs.has(spelled));
  });
  return found?.email;
}

/**
 * The attendees at the customer's domains (as `customer` says of an email) who
 * aren't the same person as an attendee outside them.
 */
export function realCustomers(value: unknown, customer: (email: string) => boolean): Attendee[] {
  const listed = attendeesOf(value);
  const others = listed.filter((a) => a.email && !customer(a.email));
  return listed.filter((a) => a.email && customer(a.email) && !twinOf(a, others));
}
