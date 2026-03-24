import * as clack from "@clack/prompts";
import { Context, Data, Effect, Layer } from "effect";

export class UserCancelled extends Data.TaggedError("UserCancelled")<{}> {}

export interface Terminal {
  readonly select: <T>(options: {
    message: string;
    choices: ReadonlyArray<{ value: T; label: string }>;
  }) => Effect.Effect<T, UserCancelled>;

  readonly confirm: (options: {
    message: string;
    initialValue?: boolean;
  }) => Effect.Effect<boolean, UserCancelled>;
}

export class TerminalService extends Context.Tag("Terminal")<TerminalService, Terminal>() {}

export const TerminalLive = Layer.succeed(TerminalService, {
  select: ({ message, choices }) =>
    Effect.gen(function* () {
      type Value = (typeof choices)[number]["value"];
      const result = yield* Effect.promise(
        // biome-ignore lint/suspicious/noExplicitAny: @clack/prompts Option<T> conditional type requires Primitive constraint, incompatible with generic T
        () =>
          clack.select({
            message,
            options: choices.map((c) => ({ value: c.value, label: c.label })) as any,
          }) as Promise<Value | symbol>
      );
      if (clack.isCancel(result)) return yield* new UserCancelled();
      return result as Value;
    }),

  confirm: ({ message, initialValue }) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() => clack.confirm({ message, initialValue }));
      if (clack.isCancel(result)) return yield* new UserCancelled();
      return result as boolean;
    }),
});

export const makeTerminalTest = (responses: unknown[]) => {
  let idx = 0;
  return Layer.succeed(TerminalService, {
    select: () => Effect.sync(() => responses[idx++] as never),
    confirm: () => Effect.sync(() => responses[idx++] as boolean),
  });
};
