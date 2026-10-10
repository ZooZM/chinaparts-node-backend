import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * A maximum length that comes from configuration (FR-070, research R24). Static decorators such
 * as `@MaxLength(500)` cannot read configuration, so they would force a code change to move a
 * limit. Resolved through Nest's container: `useContainer(...)` in `app.setup.ts` lets
 * class-validator inject `ConfigService` here.
 *
 * Length counts Unicode code points after trimming, so an emoji or a combining mark does not
 * eat two units of a limit that the spec states in characters.
 */
@ValidatorConstraint({ name: 'maxLengthFromConfig', async: false })
@Injectable()
export class MaxLengthFromConfigConstraint implements ValidatorConstraintInterface {
  constructor(private readonly config: ConfigService) {}

  validate(value: unknown, args: ValidationArguments): boolean {
    // Presence is the job of @IsNotEmpty / @IsOptional, not of this constraint.
    if (value === undefined || value === null) return true;
    if (typeof value !== 'string') return false;
    return Array.from(value.trim()).length <= this.limit(args);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be at most ${this.limit(args)} characters`;
  }

  private limit(args: ValidationArguments): number {
    const key = args.constraints[0] as string;
    const limit = this.config.get<number>(key);
    if (typeof limit !== 'number' || Number.isNaN(limit)) {
      throw new Error(`Configuration value ${key} is missing or not a number`);
    }
    return limit;
  }
}

export function MaxLengthFromConfig(
  configKey: string,
  options?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      target: target.constructor,
      propertyName: String(propertyName),
      options,
      constraints: [configKey],
      validator: MaxLengthFromConfigConstraint,
    });
  };
}
