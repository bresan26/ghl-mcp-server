import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const GHL_API_KEY = process.env.GHL_API_KEY;
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const PORT = process.env.PORT || 3000;

if (!GHL_API_KEY || !LOCATION_ID) {
  console.error('Missing env vars: GHL_API_KEY and GHL_LOCATION_ID are required.');
  process.exit(1);
}
// GHL API helper
async function ghl(method, path, body) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function buildServer() {
  const server = new McpServer({ name: 'ghl-novoideas', version: '1.0.0' });

  server.tool(
    'buscar_contactos',
    'Busca contactos en GHL por nombre, email o telefono.',
    { query: z.string().describe('Nombre, email o telefono a buscar') },
    async ({ query }) => {
      const data = await ghl('GET', `/contacts/?locationId=${LOCATION_ID}&query=${encodeURIComponent(query)}&limit=10`);
      const list = (data.contacts || []).map(c => ({
        id: c.id,
        nombre: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        email: c.email,
        telefono: c.phone,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }
  );

  server.tool(
    'listar_tareas',
    'Lista todas las tareas asignadas a un contacto de GHL.',
    { contactId: z.string().describe('ID del contacto en GHL') },
    async ({ contactId }) => {
      const data = await ghl('GET', `/contacts/${contactId}/tasks`);
      const tareas = (data.tasks || []).map(t => ({
        id: t.id,
        titulo: t.title,
        vencimiento: t.dueDate,
        completada: t.completed,
        descripcion: t.body,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(tareas, null, 2) }] };
    }
  );

  server.tool(
    'crear_tarea',
    'Crea una nueva tarea en GHL para un contacto.',
    {
      contactId:   z.string().describe('ID del contacto'),
      titulo:      z.string().describe('Titulo de la tarea'),
      vencimiento: z.string().describe('Fecha limite en formato ISO (ej: 2026-11-10T17:00:00+00:00)'),
      descripcion: z.string().optional().describe('Descripcion o notas adicionales'),
      asignadoA:   z.string().optional().describe('User ID del responsable (opcional)'),
    },
    async ({ contactId, titulo, vencimiento, descripcion, asignadoA }) => {
      const payload = {
        title: titulo,
        dueDate: vencimiento,
        completed: false,
        ...(descripcion && { body: descripcion }),
        ...(asignadoA  && { assignedTo: asignadoA }),
      };
      const data = await ghl('POST', `/contacts/${contactId}/tasks`, payload);
      return { content: [{ type: 'text', text: `Tarea creada: ${JSON.stringify(data, null, 2)}` }] };
    }
  );

  server.tool(
    'completar_tarea',
    'Marca una tarea de GHL como completada.',
    {
      contactId: z.string(),
      tareaId:   z.string().describe('ID de la tarea'),
    },
    async ({ contactId, tareaId }) => {
      const data = await ghl('PUT', `/contacts/${contactId}/tasks/${tareaId}`, { completed: true });
      return { content: [{ type: 'text', text: `Tarea completada: ${JSON.stringify(data, null, 2)}` }] };
    }
  );

  server.tool(
    'actualizar_tarea',
    'Actualiza el titulo, fecha limite o descripcion de una tarea.',
    {
      contactId:   z.string(),
      tareaId:     z.string(),
      titulo:      z.string().optional(),
      vencimiento: z.string().optional(),
      descripcion: z.string().optional(),
      completada:  z.boolean().optional(),
    },
    async ({ contactId, tareaId, titulo, vencimiento, descripcion, completada }) => {
      const payload = {
        ...(titulo      && { title: titulo }),
        ...(vencimiento && { dueDate: vencimiento }),
        ...(descripcion && { body: descripcion }),
        ...(completada  !== undefined && { completed: completada }),
      };
      const data = await ghl('PUT', `/contacts/${contactId}/tasks/${tareaId}`, payload);
      return { content: [{ type: 'text', text: `Tarea actualizada: ${JSON.stringify(data, null, 2)}` }] };
    }
  );

  server.tool(
    'eliminar_tarea',
    'Elimina una tarea de GHL.',
    {
      contactId: z.string(),
      tareaId:   z.string(),
    },
    async ({ contactId, tareaId }) => {
      await ghl('DELETE', `/contacts/${contactId}/tasks/${tareaId}`);
      return { content: [{ type: 'text', text: 'Tarea eliminada correctamente.' }] };
    }
  );

  server.tool(
    'tareas_pendientes',
    'Lista las tareas pendientes (no completadas) de un contacto, ordenadas por fecha.',
    { contactId: z.string() },
    async ({ contactId }) => {
      const data = await ghl('GET', `/contacts/${contactId}/tasks`);
      const pendientes = (data.tasks || [])
        .filter(t => !t.completed)
        .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
        .map(t => ({
          id: t.id,
          titulo: t.title,
          vencimiento: t.dueDate,
          vencida: new Date(t.dueDate) < new Date(),
          descripcion: t.body,
        }));
      const vencidas = pendientes.filter(t => t.vencida).length;
      return {
        content: [{
          type: 'text',
          text: `${pendientes.length} tareas pendientes (${vencidas} vencidas):\n${JSON.stringify(pendientes, null, 2)}`,
        }],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'GHL MCP Server', location: LOCATION_ID });
});

app.post('/mcp', async (req, res) => {
  try {
    const server    = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.delete('/mcp', (req, res) => res.status(405).end());
app.get('/mcp',    (req, res) => res.status(405).end());

app.listen(PORT, () => {
  console.log(`GHL MCP Server -- NOVOIDEAS -- escuchando en :${PORT}`);
});
