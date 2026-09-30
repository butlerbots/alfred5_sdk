import { afterEach, describe, expect, it } from "bun:test";

import { ButlerBotClient, ButlerBotAPIError } from "../index";
import { CONFIG } from "../config";
import { judge } from "../modules/judge";
import type { JudgeAnswers, JudgeBooleanAnswer, JudgeChoiceAnswer, JudgeScoreAnswer } from "../types/judge";
import { fakeFetch, pathOf, queryOf, type FakeFetch } from "./support/fake_fetch";

// =============================================
// THE JUDGE OVER HTTP
// =============================================

/**
 * A decision on stated facts. The module is a URL, a body and what the server said, so what is
 * worth asserting is the call that went out, the answers typed by their questions, and that a
 * refusal is the error the server gave and never a guess.
 */

const KEY = "ap-abc_123";

let http: FakeFetch | undefined;

afterEach(() => {
    http?.restore();
    http = undefined;
});

const QUESTIONS = {
    hostile: {
        type: "boolean" as const,
        instructions: "Is the message hostile?",
        criteria: { true: "It attacks or insults someone", false: "It is civil, however blunt" },
    },
    rule: {
        type: "choice" as const,
        instructions: "Which rule does the message break?",
        criteria: { spam: "Promotional or repeated", abuse: "Insults a person", none: "No rule is broken" },
    },
    heat: {
        type: "score" as const,
        instructions: "How heated is the message?",
        criteria: ["Calm", "Annoyed", "Furious"],
    },
};

const ANSWERS = {
    hostile: { type: "boolean" as const, value: true, probability: 0.83 },
    rule: { type: "choice" as const, choice: "abuse" as const, confidence: 0.7, probabilities: { spam: 0.1, abuse: 0.7, none: 0.2 } },
    heat: { type: "score" as const, score: 1.2, level: 1, confidence: 0.6, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 } },
};

describe("Asking the judge", () => {
    it("posts the state and the questions to the judge route with the key", async () => {
        http = fakeFetch({ body: { success: true, answers: ANSWERS, model: "typesafe/jev-1.13", costUsd: 0.00042 } });

        const state = { message: "You are all idiots.", channel: "general" };
        const verdict = await judge({ apiKey: KEY, serverURL: "https://core.test", state, questions: QUESTIONS });

        const call = http.only();
        expect(call.method).toBe("POST");
        expect(pathOf(call)).toBe(`https://core.test${CONFIG.paths.judge.base}`);
        expect(queryOf(call)).toEqual({ api_key: KEY });
        expect(call.body).toEqual({ state, questions: QUESTIONS });

        expect(verdict).toEqual({ answers: ANSWERS, model: "typesafe/jev-1.13", costUsd: 0.00042 });
    });

    it("types each answer by its question", async () => {
        http = fakeFetch({ body: { success: true, answers: ANSWERS, model: "typesafe/jev-1.13", costUsd: 0.00042 } });

        const { answers } = await judge({ apiKey: KEY, state: "a message", questions: QUESTIONS });

        // What the types say: a boolean's value, a choice's label off its own criteria, a score's level.
        const hostile: JudgeBooleanAnswer = answers.hostile;
        const rule: JudgeChoiceAnswer<"spam" | "abuse" | "none"> = answers.rule;
        const heat: JudgeScoreAnswer = answers.heat;
        const typed: JudgeAnswers<typeof QUESTIONS> = answers;

        expect(hostile.value).toBe(true);
        expect(rule.choice).toBe("abuse");
        expect(rule.probabilities?.none).toBe(0.2);
        expect(heat.level).toBe(1);
        expect(typed.heat.score).toBeCloseTo(1.2);
    });

    it("takes the state as text, and defaults to the hosted core", async () => {
        http = fakeFetch({ body: { success: true, answers: { hostile: ANSWERS.hostile }, model: "typesafe/jev-1.13", costUsd: 0.0001 } });

        await judge({ apiKey: KEY, state: "A message in #general: you are all idiots.", questions: { hostile: QUESTIONS.hostile } });

        const call = http.only();
        expect(pathOf(call)).toBe(`${CONFIG.server}${CONFIG.paths.judge.base}`);
        expect((call.body as { state: string }).state).toBe("A message in #general: you are all idiots.");
    });

    it("throws the server's refusal of a question it cannot ask, with the judge's message", async () => {
        http = fakeFetch({
            status: 400,
            body: { success: false, validationErrors: [{ path: ["questions"], message: "The judge cannot ask these questions: rule: a choice needs at least two labels." }] },
        });

        let thrown: unknown;
        try {
            await judge({ apiKey: KEY, state: "a message", questions: { rule: { type: "choice", instructions: "Which rule?", criteria: { spam: "Spam" } } } });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(ButlerBotAPIError);
        expect((thrown as ButlerBotAPIError).isBadRequest).toBe(true);
        expect(JSON.stringify((thrown as ButlerBotAPIError).body)).toContain("a choice needs at least two labels");
    });

    it("throws when the judge could not decide, never a guess", async () => {
        http = fakeFetch({ status: 503, body: { success: false, error: "The judge could not decide", errormessage: "The judge could not decide: The decisions endpoint answered 502" } });

        let thrown: unknown;
        try {
            await judge({ apiKey: KEY, state: "a message", questions: { hostile: QUESTIONS.hostile } });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(ButlerBotAPIError);
        expect((thrown as ButlerBotAPIError).status).toBe(503);
        expect((thrown as ButlerBotAPIError).errormessage).toContain("could not decide");
    });
});

describe("The client", () => {
    it("asks the judge with its own key and server", async () => {
        http = fakeFetch({ body: { success: true, answers: { hostile: ANSWERS.hostile }, model: "typesafe/jev-1.13", costUsd: 0.0001 } });

        const client = new ButlerBotClient({ apiKey: KEY, serverUrl: "https://core.test" });
        const { answers, costUsd } = await client.judge({ state: "a message", questions: { hostile: QUESTIONS.hostile } });

        expect(pathOf(http.only())).toBe("https://core.test/api/judge");
        expect(queryOf(http.only())).toEqual({ api_key: KEY });
        expect(answers.hostile.value).toBe(true);
        expect(costUsd).toBe(0.0001);
    });
});
