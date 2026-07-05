import { pgTable, text, jsonb, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const resolvedAlbumsTable = pgTable("resolved_albums", {
  url: text("url").primaryKey(),
  albumName: text("album_name"),
  files: jsonb("files").notNull().$type<
    Array<{
      name: string;
      url: string;
      size: number | null;
      type: string;
      thumbnailUrl: string | null;
      cdnUrl: string | null;
    }>
  >(),
  totalFiles: integer("total_files").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertResolvedAlbumSchema = createInsertSchema(resolvedAlbumsTable);
export type InsertResolvedAlbum = z.infer<typeof insertResolvedAlbumSchema>;
export type ResolvedAlbum = typeof resolvedAlbumsTable.$inferSelect;

export const searchResultsTable = pgTable("search_results", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  query: text("query").notNull(),
  mode: text("mode").notNull().default("broad"),
  page: integer("page").notNull().default(1),
  results: jsonb("results").notNull().$type<
    Array<{
      title: string;
      url: string;
      thumbnailUrl: string | null;
      source: string;
    }>
  >(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertSearchResultSchema = createInsertSchema(searchResultsTable);
export type InsertSearchResult = z.infer<typeof insertSearchResultSchema>;
export type SearchResult = typeof searchResultsTable.$inferSelect;
