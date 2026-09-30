import { CONFIG } from "../config";
import type { JudgeQuestions, JudgeResponse, JudgeState, JudgeVerdict } from "../types/judge";
import { formatURL } from "../util/url_formatter";
import { requestAPI } from "./api_request";

/** What a judge call needs: where the server is, and who is asking. */
export type JudgeRequestOptions = {
    serverURL?: string;
    /** The path of the judge route, when it is not the default. */
    path?: string;
    apiKey: string;
    debug?: boolean;
};

export type JudgeOptions<Q extends JudgeQuestions = JudgeQuestions> = JudgeRequestOptions & {
    /**
     * The facts the questions are answered from: the message, who sent it, the rules, numbers
     * and dates already worked out in code. Never a transcript or an argument for an answer.
     */
    state: JudgeState;
    /** The questions, by the id the answer is read back under. All are judged against the same state in one call. */
    questions: Q;
};

/**
 * Asks the judge: a yes/no, pick-one or score decision on the facts given, made by a decision
 * model in well under a second for a fraction of a cent.
 *
 * The answers come back keyed by question id and typed by the question: a boolean's `value` and
 * `probability`, a choice's `choice` (one of its criteria's keys), `confidence` and
 * `probabilities`, a score's `level`, `score` and `confidence`. The model writes no text and
 * gives no reason.
 *
 * A question the judge cannot ask (a boolean missing one side, a choice with one label, a score
 * with more than ten levels) is a 400 carrying the judge's own message, and a judgement not
 * reached is a 503: the call throws a `ButlerBotAPIError` either way, never a guess.
 */
export async function judge<Q extends JudgeQuestions>(options: JudgeOptions<Q>): Promise<JudgeVerdict<Q>> {
    const url = formatURL(
        (options.serverURL || CONFIG.server) + (options.path || CONFIG.paths.judge.base),
        {},
        { apiKey: options.apiKey, debug: options.debug },
    );

    const response = await requestAPI<JudgeResponse<Q>>({
        url,
        method: "POST",
        body: { state: options.state, questions: options.questions },
        action: "ask the judge",
    });

    return { answers: response.answers, model: response.model, costUsd: response.costUsd };
}
