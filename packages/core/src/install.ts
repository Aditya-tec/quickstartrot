const INSTALL =
  /(?:^|[\s;&|])(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|pip3?\s+install\b|python3?\s+-m\s+pip\s+install\b|uv\s+(?:pip\s+install|add)\b|poetry\s+add\b)/;

/** Whether a shell command installs packages: the steps whose success is level 1. */
export const isInstallCommand = (command: string): boolean => INSTALL.test(command);
