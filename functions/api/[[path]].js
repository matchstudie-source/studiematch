// Alle /api/*-kald håndteres af server/api.js
import { handle } from "../../server/api.js";

export const onRequest = (ctx) => handle(ctx);
