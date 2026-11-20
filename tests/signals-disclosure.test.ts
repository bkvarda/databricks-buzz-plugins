// Synthetic drafts: an internal link is fine in Internal notes and flagged in
// the Customer draft; a reply with no customer part is unchecked.
import { describe, expect, it } from "vitest";
import { disclosureCheck, draftSections, internalHits } from "../plugins/signals/app/disclosure";

const customer = (body: string) => `## Customer draft\nHi Ann,\n\n${body}\n\nThanks,\nSam`;
const internal = (body: string) => `## Internal notes\n${body}`;

const INTERNAL_LINKS: [string, string][] = [
  ["go link", "See go/roadmaptool for the date."],
  ["Jira or Confluence", "Tracked in https://databricks.atlassian.net/browse/ES-1234567."],
  ["internal ticket", "Root cause is in ES-2331845."],
  ["Brickroad", "There's already brickroad:issue/11732 for this."],
  ["Buzz link", "Discussed in buzz://message?channel=c1&id=abc."],
  ["Slack link", "Per https://databricks.slack.com/archives/C01/p1700000000."],
  ["Google Drive", "The FAQ is at https://drive.google.com/file/d/1bXh/view."],
  ["workspace link", "Repro in https://fevm-buzz-lakebase-lab.cloud.databricks.com/jobs/1."],
  ["internal date", "Eng availability is 2027-02-15."],
  ["layout note", "Serverless is supported *(full size, not a footnote)*."],
  ["layout note", "(optional: SA decides) We can also set up a call."],
];

describe("disclosure check", () => {
  it.each(INTERNAL_LINKS)("flags a %s in the customer draft", (kind, line) => {
    const result = disclosureCheck(`${customer(line)}\n\n${internal("Nothing here.")}`);
    expect(result).toMatchObject({ status: "warned", kinds: expect.arrayContaining([kind]) });
  });

  it.each(INTERNAL_LINKS)("allows a %s in internal notes", (_kind, line) => {
    expect(disclosureCheck(`${customer("Managed Iceberg tables follow the open Iceberg spec: https://docs.databricks.com/aws/en/iceberg/")}\n\n${internal(line)}`)).toEqual({ status: "clean" });
  });

  it("leaves a reply with no customer part unchecked", () => {
    expect(disclosureCheck("Hi Ann, see go/roadmaptool.")).toEqual({ status: "unchecked" });
    expect(disclosureCheck(internal("go/roadmaptool"))).toEqual({ status: "unchecked" });
    expect(disclosureCheck(`## Customer draft\n\n${internal("go/roadmaptool")}`)).toEqual({ status: "unchecked" });
    expect(disclosureCheck(`Preamble go/roadmaptool\n${customer("All set.")}`)).toEqual({ status: "clean" });
  });

  it("keeps a Sources subheading inside the customer draft", () => {
    const text = "## Customer draft\nHi Ann, here's the plan.\n\n### Sources\n- go/example\n\n## Internal notes\nNothing.";
    expect(draftSections(text)).toMatchObject({ customer: "Hi Ann, here's the plan.\n\n### Sources\n- go/example", internal: "Nothing." });
    expect(disclosureCheck(text)).toEqual({ status: "warned", kinds: ["go link"] });
  });

  it("goes back to customer text after internal notes when another customer heading follows", () => {
    const text = `${internal("ES-1234567")}\n\n**Customer reply:**\nSee INC-6588.`;
    expect(draftSections(text)).toEqual({ customer: "See INC-6588.", internal: "ES-1234567", marked: true });
    expect(disclosureCheck(text)).toEqual({ status: "warned", kinds: ["internal ticket"] });
  });

  it("reads common heading shapes", () => {
    for (const heading of ["# Customer draft", "### Draft email to the customer", "**Customer-facing reply**", "Customer draft:", "📧 Email draft"])
      expect(draftSections(`${heading}\nhello\n## Internal notes\nES-1234567`)).toMatchObject({ customer: "hello", marked: true });
  });

  it.each(["```", "~~~", "````"])("doesn't take a heading inside a %s code block", (fence) => {
    expect(draftSections(`## Customer draft\n${fence}\n## Internal notes\n${fence}\nES-1234567`).customer).toContain("ES-1234567");
  });

  it("doesn't close a fence on a marker with text after it", () => {
    const text = "## Customer draft\n~~~text\n~~~ snippet\n## Internal notes\ngo/example";
    expect(draftSections(text)).toMatchObject({ internal: "" });
    expect(disclosureCheck(text)).toEqual({ status: "warned", kinds: ["go link"] });
    expect(draftSections("## Customer draft\n~~~\nx\n~~~   \n## Internal notes\ngo/example")).toMatchObject({ internal: "go/example" });
  });

  it("closes a fence only with the same kind of fence", () => {
    expect(draftSections("## Customer draft\n~~~\n```\n## Internal notes\n~~~\n## Internal notes\nES-1234567")).toMatchObject({ internal: "ES-1234567" });
  });

  it("leaves ordinary parentheses alone", () => {
    expect(internalHits("Ingest (optionally with Auto Loader) is supported (see the docs).")).toEqual([]);
    expect(internalHits("Enable serverless compute (optional) before continuing.")).toEqual([]);
    expect(internalHits("Set a budget policy (optional: recommended for production).")).toEqual([]);
    expect(internalHits("(Optional) Add a tag.")).toEqual([]);
    expect(internalHits("Set up a budget alert (optional: decide who should receive notifications).")).toEqual([]);
    expect(internalHits("Pick a region (optional: your decision, defaults to us-east-1).")).toEqual([]);
  });

  it("flags optional only with a sender cue", () => {
    for (const text of ["(optional: SA decides) Add a call.", "Add a slide *(optional, AE decision)*.", "(Optional - SA decides whether to include)", "(optional: AE's call)"])
      expect(internalHits(text).map((hit) => hit.kind)).toEqual(["layout note"]);
    expect(disclosureCheck(`${customer("Enable serverless compute (optional) before continuing.")}\n\n${internal("(optional: SA decides) Mention the roadmap.")}`)).toMatchObject({ status: "clean" });
  });

  it("leaves public Databricks docs alone", () => {
    expect(internalHits("https://docs.databricks.com/aws/en/iceberg/ and https://www.databricks.com/product/roadmap")).toEqual([]);
  });
});
