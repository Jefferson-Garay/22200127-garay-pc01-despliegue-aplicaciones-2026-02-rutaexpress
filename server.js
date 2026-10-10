const express = require("express");
const { Pool } = require("pg");
const { randomUUID } = require("crypto");

const app = express();
const instance = process.env.INSTANCE_ID || "local";

const pool = new Pool({
  host: process.env.DB_HOST || "db",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionTimeoutMillis: 3000,
});

pool.on("error", (error) => {
  console.error("Error de PostgreSQL:", error.code || "DB_ERROR");
});

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// Registrar cada solicitud antes de leer o validar su contenido.
app.use(asyncRoute(async (req, res, next) => {
  res.setHeader("X-Instance-ID", instance);

  const receivedId = req.get("X-Request-ID") || "";
  req.requestId = /^[a-f0-9-]{36}$/i.test(receivedId)
    ? receivedId
    : randomUUID();

  const operationKey = req.get("Idempotency-Key") || null;
  req.operationKey = operationKey;
  req.auditId = null;

  try {
    let result = await pool.query(
      `INSERT INTO intentos
         (request_id, clave_operacion, metodo, ruta, instancia)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (request_id) DO NOTHING
       RETURNING id`,
      [req.requestId, operationKey, req.method, req.path, instance]
    );

    // Cada intento debe conservar un identificador único.
    if (result.rowCount === 0) {
      req.requestId = randomUUID();

      result = await pool.query(
        `INSERT INTO intentos
           (request_id, clave_operacion, metodo, ruta, instancia)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [req.requestId, operationKey, req.method, req.path, instance]
      );
    }

    req.auditId = result.rows[0].id;
    res.setHeader("X-Request-ID", req.requestId);

    res.on("finish", () => {
      pool.query(
        `UPDATE intentos
         SET codigo_http_emitido = $1,
             respuesta_finalizada_en = clock_timestamp()
         WHERE id = $2`,
        [res.statusCode, req.auditId]
      ).catch((error) => {
        console.error("Error al registrar respuesta:", error.code);
      });
    });

    res.on("close", () => {
      if (!res.writableFinished) {
        pool.query(
          `UPDATE intentos
           SET conexion_cerrada_antes_de_responder = TRUE
           WHERE id = $1`,
          [req.auditId]
        ).catch((error) => {
          console.error("Error al registrar cierre:", error.code);
        });
      }
    });

    next();
  } catch (error) {
    next(error);
  }
}));

app.use(express.json({ limit: "16kb" }));

async function recordResult(req, outcome, status, envioId = null, code = null) {
  await pool.query(
    `UPDATE intentos
     SET resultado = $1,
         codigo_http_previsto = $2,
         envio_id = $3,
         codigo_error = $4,
         procesado_en = clock_timestamp()
     WHERE id = $5`,
    [outcome, status, envioId, code, req.auditId]
  );
}

app.get("/health", asyncRoute(async (req, res) => {
  await pool.query("SELECT 1");
  await recordResult(req, "aceptado", 200);

  res.json({
    status: "ok",
    database: "ok",
    instance,
  });
}));

app.post("/envios", asyncRoute(async (req, res) => {
  const key = req.operationKey;
  const { destinatario, direccion } = req.body || {};

  if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    await recordResult(req, "rechazado", 400, null, "INVALID_OPERATION_KEY");

    return res.status(400).json({
      error: "Envía Idempotency-Key: de 1 a 128 caracteres, sin espacios.",
    });
  }

  if (
    typeof destinatario !== "string" ||
    typeof direccion !== "string" ||
    !destinatario.trim() ||
    !direccion.trim()
  ) {
    await recordResult(req, "rechazado", 400, null, "INVALID_BODY");

    return res.status(400).json({
      error: "destinatario y direccion deben ser textos no vacíos.",
    });
  }

  const client = await pool.connect();
  let envio;
  let created;
  let conflict;
  let status;

  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO envios (clave_operacion, destinatario, direccion)
       VALUES ($1, $2, $3)
       ON CONFLICT (clave_operacion) DO NOTHING
       RETURNING id, destinatario, direccion`,
      [key, destinatario, direccion]
    );

    created = inserted.rowCount === 1;

    if (created) {
      envio = inserted.rows[0];
    } else {
      const existing = await client.query(
        `SELECT id, destinatario, direccion
         FROM envios
         WHERE clave_operacion = $1`,
        [key]
      );

      envio = existing.rows[0];

      if (!envio) {
        throw new Error("OPERATION_NOT_FOUND");
      }
    }

    conflict =
      envio.destinatario !== destinatario ||
      envio.direccion !== direccion;

    status = conflict ? 409 : created ? 201 : 200;
    const outcome = conflict ? "rechazado" : created ? "creado" : "repetido";

    await client.query(
      `UPDATE intentos
       SET resultado = $1,
           envio_id = $2,
           codigo_http_previsto = $3,
           codigo_error = $4,
           procesado_en = clock_timestamp()
       WHERE id = $5`,
      [
        outcome,
        envio.id,
        status,
        conflict ? "KEY_PAYLOAD_CONFLICT" : null,
        req.auditId,
      ]
    );

    // El envío y el resultado quedan guardados antes de responder.
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (conflict) {
    return res.status(409).json({
      error: "Esta clave de operación ya se utilizó con otros datos.",
    });
  }

  // Solo se activa expresamente para la prueba de timeout.
  if (
    created &&
    process.env.ENABLE_TEST_DELAY === "true" &&
    req.get("X-Test-Delay") === "true"
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (!res.destroyed) {
    res.status(status).json({
      id: envio.id,
      destinatario: envio.destinatario,
      direccion: envio.direccion,
    });
  }
}));

app.use(asyncRoute(async (req, res) => {
  await recordResult(req, "rechazado", 404, null, "ROUTE_NOT_FOUND");
  res.status(404).json({ error: "Ruta no encontrada." });
}));

app.use((error, req, res, next) => {
  const invalidJson =
    error.type === "entity.parse.failed" ||
    error.type === "entity.too.large";

  const status = invalidJson ? 400 : 503;
  const code = invalidJson
    ? "INVALID_JSON"
    : error.code || "SERVICE_ERROR";

  const finish = async () => {
    if (req.auditId) {
      await recordResult(
        req,
        invalidJson ? "rechazado" : "fallido",
        status,
        null,
        code
      ).catch(() => {
        console.error("No se pudo actualizar el intento:", req.requestId);
      });
    }

    console.error("Solicitud fallida:", req.requestId, code);

    if (!res.headersSent && !res.destroyed) {
      res.status(status).json({
        error: invalidJson
          ? "El cuerpo JSON es inválido o demasiado grande."
          : "Servicio temporalmente no disponible.",
      });
    }
  };

  finish().catch(next);
});

app.listen(3000, "0.0.0.0", () => {
  console.log(`Instancia ${instance} escuchando en el puerto 3000`);
});