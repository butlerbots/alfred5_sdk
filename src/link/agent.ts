import { LinkAgentDescriptor, LinkServerFrame, LinkServerFrameOf } from "./protocol";
import { AnyTool } from "./tool";

export type AgentConfig = {
    /**
     * This agent's id within the link. The public id becomes `link:<linkId>/<id>`,
     * which is what the user's saved settings refer to — so treat it as permanent.
     */
    id: string;
    /** The agent's own name. It signs its replies with it. */
    name: string;
    /** What Alfred reads when deciding whether to hand something to this agent. */
    description: string;
    /**
     * The agent's system prompt: who it is, what its tools are for, and how they go together.
     * This is where a thousand tools become one coherent worker.
     */
    prompt: string;
    /**
     * The model the agent runs on, by its catalogue name. Omit it for the user's default.
     * A model the user's plan does not include falls back to their default, exactly as a chat would.
     */
    model?: string;
    /**
     * The tools the agent works with. They belong to the agent: Alfred never sees them
     * directly, and they need no `addTool` of their own.
     */
    tools?: AnyTool[];
    /** Shown in Alfred's settings UI. Without it the agent is hidden there. */
    display?: {
        name: string;
        shortDescription: string;
        longDescription: string;
    };
    /** Whether the agent is on before the user has touched it. */
    defaultEnabled?: boolean;
};

/** Progress on an exchange, in the words the agent's status feed would show a conversation. */
export type AgentStatus = { label: string; state: "running" | "completed" | "failed" };

export type AgentChatOptions = {
    /**
     * The exchange this message continues. Messages on one thread share memory.
     *
     * Defaults to the agent's own thread, which is minted when the `Agent` is created — so one
     * `Agent` remembers across `chat` calls, and a new process starts afresh. Name one yourself
     * to pick a conversation up across restarts, or to keep several going at once.
     */
    thread?: string;
    /** Called with each status update while the agent works. */
    onStatus?: (status: AgentStatus) => void;
};

export type AgentReply = {
    /** What the agent said. */
    text: string;
    /** The thread the reply belongs to, which is what continues it. */
    thread: string;
};

/** What an agent needs from its link. Implemented by `Link`. */
export type AgentRunner = {
    chatAgent(agentId: string, message: string, options: AgentChatOptions): Promise<AgentReply>;
};

/**
 * An AI worker that lives on the server for as long as the link does, working with tools
 * that run here.
 *
 * To Alfred it is one tool: he hands it a task and gets a reply, and the tools behind it
 * stay behind it. To your code it is something to talk to directly — `chat` runs it on the
 * server and hands the answer back here, so a hook callback can ask it to decide something
 * and act on what it says.
 */
export class Agent {
    readonly id: string;
    readonly tools: AnyTool[];

    /** The public id (`link:<linkId>/<id>`), known once the link has registered it. */
    linkedId?: string;

    /** The thread `chat` uses when not told otherwise. One per `Agent`, so it remembers. */
    thread: string;

    private link?: AgentRunner;

    constructor(private readonly config: AgentConfig) {
        this.id = config.id;
        this.tools = [...(config.tools ?? [])];
        this.thread = mintThread();

        const ids = new Set<string>();
        for (const tool of this.tools) {
            if (ids.has(tool.id)) throw new Error(`Agent "${this.id}" holds two tools with the id "${tool.id}".`);
            ids.add(tool.id);
        }
    }

    get name(): string {
        return this.config.name;
    }

    get description(): string {
        return this.config.description;
    }

    /** The declaration sent to the server. */
    descriptor(): LinkAgentDescriptor {
        return {
            localId: this.id,
            name: this.config.name,
            description: this.config.description,
            prompt: this.config.prompt,
            ...(this.config.model ? { model: this.config.model } : {}),
            // An agent's tools are placed by the agent, so whatever platform a tool
            // declared for itself does not travel.
            tools: this.tools.map(tool => {
                const { platforms: _platforms, ...descriptor } = tool.descriptor();
                return descriptor;
            }),
            ...(this.config.display ? { display: this.config.display } : {}),
            ...(this.config.defaultEnabled !== undefined ? { defaultEnabled: this.config.defaultEnabled } : {}),
        };
    }

    /** Called by `Link.addAgent`. */
    attach(link: AgentRunner): void {
        this.link = link;
    }

    /** One of this agent's tools, by its id. */
    getTool(id: string): AnyTool | undefined {
        return this.tools.find(tool => tool.id === id);
    }

    /**
     * Asks the agent something and waits for its reply.
     *
     * The run happens on the server, on the user's account; the question and the answer live
     * here. Rejects with a `LinkError` when the agent could not run or failed — never with the
     * agent's own prose, which is a reply like any other.
     */
    chat(message: string, options: AgentChatOptions = {}): Promise<AgentReply> {
        if (!this.link) return Promise.reject(new Error(`Agent "${this.id}" has not been added to a link.`));
        return this.link.chatAgent(this.id, message, { thread: this.thread, ...options });
    }

    /** Starts a fresh thread for the calls that follow, and returns it. */
    newThread(): string {
        this.thread = mintThread();
        return this.thread;
    }
}

/** A thread id the server will accept: letters, digits, dot, dash, underscore, 64 at most. */
function mintThread(): string {
    const random = Math.random().toString(36).slice(2, 10);
    return `t-${Date.now().toString(36)}-${random}`;
}

/** Whether a server frame ends an `agent.chat` exchange. */
export function isAgentResult(frame: LinkServerFrame): frame is LinkServerFrameOf<"agent.result"> {
    return frame.type === "agent.result";
}
