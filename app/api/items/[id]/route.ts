import {
  endpoint,
  json,
  protect,
  limit,
  body,
  HttpError,
} from "../../../../lib/http";
import { validatePatch } from "../../../../lib/extraction";
import { db } from "../../../../lib/db";
export const PATCH = endpoint(
  async (r, context: { params: Promise<{ id: string }> }) => {
    protect(r, true);
    await limit("review", 60);
    const { id } = await context.params;
    if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(400, "Invalid item id");
    const p = validatePatch(await body(r));
    const changes = {
      ...p,
      ...(p.status === "open" ? { confidence: 1 } : {}),
      ...(p.dueAt ? { dateOnly: null } : {}),
      ...(p.dateOnly ? { dueAt: null } : {}),
      updatedAt: new Date().toISOString(),
    };
    const rows =
      await db()`update items set data=data || ${db().json(changes as never)},manual=true where id=${id} returning data`;
    if (!rows.length) throw new HttpError(404, "Item not found");
    return json(rows[0].data);
  },
);
