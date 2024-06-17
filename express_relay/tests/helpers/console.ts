export const logLevels = ["debug", "log", "warn", "error", "none"] as const;
export type LogLevel = typeof logLevels[number];

declare global {
  var logLevel: LogLevel;
}

const shouldLog = (level: LogLevel) => {
  return logLevels.indexOf(level) >= logLevels.indexOf(global.logLevel);
};

export const setLogLevel = () => {
  const _console = console;
  global.console = {
    ...global.console,
    log: (message?: any, ...optionalParams: any[]) => {
      shouldLog("log") && _console.log(message, ...optionalParams);
    },
    warn: (message?: any, ...optionalParams: any[]) => {
      shouldLog("warn") && _console.warn(message, ...optionalParams);
    },
    error: (message?: any, ...optionalParams: any[]) => {
      shouldLog("error") && _console.error(message, ...optionalParams);
    },
    debug: (message?: any, ...optionalParams: any[]) => {
      shouldLog("debug") && _console.debug(message, ...optionalParams);
    },
  };
};
