import { Data, Effect, Schema } from "effect";

export class ApiError extends Data.TaggedError("ApiError")<{
  status: 400 | 401 | 404 | 406 | 409 | 413 | 415 | 429 | 503;
  code: string;
  message: string;
}> {}

export function invalid(message: string) {
  return new ApiError({ status: 400, code: "invalid_request", message });
}
export function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(input);
  } catch {
    throw invalid("The request does not match the API schema.");
  }
}
export function storage<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({
    try: operation,
    catch: () =>
      new ApiError({
        status: 503,
        code: "storage_unavailable",
        message: "The dataset is temporarily unavailable.",
      }),
  });
}
export async function run<A>(effect: Effect.Effect<A, ApiError>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.catchTag("ApiError", (error) => Effect.succeed(error))),
  ).then((value) => {
    if (value instanceof ApiError) throw value;
    return value;
  });
}
