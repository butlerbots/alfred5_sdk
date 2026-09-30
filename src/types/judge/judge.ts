/**
 * The judge: a yes/no, pick-one or score decision made by a decision model, on facts the caller
 * states.
 *
 * Not a conversation. It writes no text and gives no reason: one call, every question judged
 * against the same state, and typed answers back with probabilities. The state is facts (the
 * message, who sent it, the rules, numbers and dates already worked out in code), never a
 * transcript or an argument for an answer. State and the longest question together fit in about
 * 32,000 tokens.
 */

// =============================================
// QUESTIONS
// =============================================

/**
 * A yes/no question.
 *
 * Both sides are described, because the model weighs the state against each description rather
 * than against the question alone, and the server refuses a question that leaves one out.
 */
export type JudgeBooleanQuestion = {
    type: "boolean";
    /** What is being decided about the state, in one or two sentences. */
    instructions: string;
    criteria: {
        /** What a yes looks like in the state. */
        true: string;
        /** What a no looks like in the state. */
        false: string;
    };
    /** The probability of yes (between 0 and 1, exclusive) at which `value` is true. 0.5 when unset. */
    threshold?: number;
};

/**
 * Pick one label.
 *
 * Every label the answer may be is a key of `criteria`, described by its value; at least two.
 * There is no automatic "none": when the state may fit no label, add one ("none": "Nothing above
 * fits"), or the nearest label is picked however poor the fit.
 */
export type JudgeChoiceQuestion<L extends string = string> = {
    type: "choice";
    instructions: string;
    criteria: Record<L, string>;
};

/**
 * A place on an ordered scale.
 *
 * `criteria[0]` describes the bottom of the scale and each entry after it one level up; at most
 * ten levels.
 */
export type JudgeScoreQuestion = {
    type: "score";
    instructions: string;
    criteria: string[];
};

export type JudgeQuestion = JudgeBooleanQuestion | JudgeChoiceQuestion | JudgeScoreQuestion;

/** The questions of one call, by an id (1-64 letters, digits, `_` or `-`) the answer is read back under. */
export type JudgeQuestions = Record<string, JudgeQuestion>;

/** The facts the questions are answered from: text, or an object the server renders. */
export type JudgeState = string | Record<string, unknown>;

// =============================================
// ANSWERS
// =============================================

export type JudgeBooleanAnswer = {
    type: "boolean";
    /** True when `probability` reached the question's threshold. */
    value: boolean;
    /** How likely yes is, 0 to 1. */
    probability: number;
};

export type JudgeChoiceAnswer<L extends string = string> = {
    type: "choice";
    /** The label picked: one of the question's criteria keys. */
    choice: L;
    /** How sure, 0 to 1. */
    confidence: number;
    /** Every label's probability, keyed by label. */
    probabilities?: Partial<Record<L, number>>;
};

export type JudgeScoreAnswer = {
    type: "score";
    /** The probability-weighted mean of the levels, 0-based; a fraction when the model is torn. */
    score: number;
    /** The single most likely level, 0-based: an index into the question's `criteria`. */
    level: number;
    /** How sure of `level`, 0 to 1. */
    confidence: number;
    /** Each level's probability, keyed by its index as a string. */
    probabilities?: Record<string, number>;
};

export type JudgeAnswer = JudgeBooleanAnswer | JudgeChoiceAnswer | JudgeScoreAnswer;

/** The answer a question gets, typed by the question: a choice's label is one of its criteria's keys. */
export type JudgeAnswerFor<Q extends JudgeQuestion> =
    Q extends JudgeBooleanQuestion ? JudgeBooleanAnswer
    : Q extends JudgeChoiceQuestion ? JudgeChoiceAnswer<Extract<keyof Q["criteria"], string>>
    : Q extends JudgeScoreQuestion ? JudgeScoreAnswer
    : never;

export type JudgeAnswers<Q extends JudgeQuestions> = { [K in keyof Q]: JudgeAnswerFor<Q[K]> };

/** What a decision comes back as. */
export type JudgeVerdict<Q extends JudgeQuestions = JudgeQuestions> = {
    /** One answer per question, under the question's id. */
    answers: JudgeAnswers<Q>;
    /** The decision model that answered. */
    model: string;
    /** What the judgement cost, USD. It is already on the account's ledger. */
    costUsd: number;
};

/** The route's whole answer. */
export type JudgeResponse<Q extends JudgeQuestions = JudgeQuestions> = JudgeVerdict<Q> & { success: true };
