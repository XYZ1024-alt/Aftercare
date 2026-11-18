import { createHttpApi, type HttpApi, openConsoleContext } from '@aftercare/console';

// One console API per server process. Database credentials and the model
// credential are read here, on the server, from the process environment;
// nothing of them is serialised into a page or a client bundle.

const holder: { api?: HttpApi } = {};

export function consoleApi(): HttpApi {
  holder.api ??= createHttpApi(openConsoleContext(process.env, 'web'), process.env);
  return holder.api;
}
