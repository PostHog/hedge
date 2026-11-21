export const reservedKeys = ["constructor", "prototype", "__proto__"];

export const isT3Slug = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !reservedKeys.includes(value);

export const isRowProvider = (value: unknown): value is string => isT3Slug(value) && value !== "claudeAgent";
