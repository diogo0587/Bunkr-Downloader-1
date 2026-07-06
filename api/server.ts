import path from "path";
import express from "express";
import indexHandler from "./index";

const app = express();

// Servir arquivos estáticos da SPA
const publicPath = path.join(process.cwd(), "artifacts/bunkr-downloader/dist/public");
app.use(express.static(publicPath));

// Rotas de API
app.use("/api", indexHandler);

// Fallback para SPA - serve index.html pra todas as rotas que não começam com /api
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(publicPath, "index.html"));
  } else {
    res.status(404).json({ error: "API route not found" });
  }
});

export default app;
