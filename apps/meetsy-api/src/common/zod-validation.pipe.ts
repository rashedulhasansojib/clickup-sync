import { BadRequestException, PipeTransform } from "@nestjs/common";
import { z } from "zod";

/**
 * Small pipe that validates a request body against a @ma/shared zod schema and
 * returns the parsed, typed value. Throws 400 with field-level detail on failure.
 *
 * Usage: @Body(new ZodValidationPipe(CreateMeetingRequestSchema)) body: CreateMeetingRequest
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: "Validation failed",
        errors: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}
