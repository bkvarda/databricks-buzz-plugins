// A rule's `classify` question, put to a small model on Databricks Model
// Serving: by default databricks-openjev-qwen35-4b, which takes
// {state, questions} and answers each yes/no question with the probability
// of yes (answers.<name>.noul). The hub calls it as its service principal,
// only for an event a rule matched that would open a new task.
import { type Classify, classifyQuestions, classifyState, type EventInput } from "./model";
import type { Classifier } from "./store";

export const DEFAULT_CLASSIFIER_ENDPOINT = "databricks-openjev-qwen35-4b";

type Call = (path: string, init: { method: "POST"; body: unknown }) => Promise<unknown>;

/** The probability of yes in a classifier's answer, or undefined when the answer has none. */
export function answerScore(answer: unknown): number | undefined {
  const noul = (answer as { answers?: { classify?: { noul?: unknown } } } | undefined)?.answers?.classify?.noul;
  return typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : undefined;
}

/**
 * A classifier that asks the serving endpoint. `call` is a Databricks REST
 * call (the app's `databricks.api`). Errors and odd answers give undefined, so
 * the task opens (fails open); `log` hears why.
 */
export function jevClassifier(call: Call, endpoint = DEFAULT_CLASSIFIER_ENDPOINT, log?: (line: string) => void): Classifier {
  return async (event: EventInput, classify: Classify) => {
    try {
      const answer = await call(`/serving-endpoints/${encodeURIComponent(endpoint)}/invocations`, { method: "POST", body: { state: classifyState(event), questions: classifyQuestions(classify) } });
      const score = answerScore(answer);
      if (score === undefined) log?.(`classifier ${endpoint} gave no score for ${event.source} ${event.external_id}`);
      return score;
    } catch (error) {
      log?.(`classifier ${endpoint} failed for ${event.source} ${event.external_id}: ${(error as Error).message}`);
      return undefined;
    }
  };
}
