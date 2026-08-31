export class FoundationError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConfigurationError extends FoundationError {
  constructor(message: string, options?: ErrorOptions) {
    super('CONFIGURATION_ERROR', message, options);
  }
}

export class DatabaseInitializationError extends FoundationError {
  constructor(message: string, options?: ErrorOptions) {
    super('DATABASE_INITIALIZATION_ERROR', message, options);
  }
}

export class MigrationError extends FoundationError {
  constructor(message: string, options?: ErrorOptions) {
    super('MIGRATION_ERROR', message, options);
  }
}
