import fs from 'node:fs';
import path from 'node:path';

const RESOURCES = new Set(['.glb', '.gltf', '.obj', '.stl', '.3mf', '.step', '.stp', '.iges', '.igs', '.brep', '.brp', '.mtl', '.bin', '.png', '.jpg', '.jpeg', '.webp']);
function relevant(filename) {
  const parts = String(filename ?? '').replaceAll('\\', '/').split('/').filter(Boolean);
  if (!parts.length || !RESOURCES.has(path.extname(parts.at(-1)).toLowerCase())) return false;
  if (parts.some(part => ['node_modules', 'target', '.git', '.cache'].includes(part.toLowerCase()))) return false;
  return parts.every((part, index) => !part.startsWith('.') || part === '.trylo' && parts[index + 1] === 'out');
}

/** One recursive watcher per project; no model request or parsing runs here. */
export function createModelPreviewWatch({ changed, watch = fs.watch, schedule = (callback, delay) => setTimeout(callback, delay), cancel = clearTimeout } = {}) {
  const projects = new Map();
  const notify = async (session, generation, error, files) => {
    try { await changed(session, generation, error, files); }
    catch { /* A disconnected watch observer cannot own or stop a model request. */ }
  };
  return {
    open(session) {
      let project = projects.get(session.projectRoot);
      if (!project) {
        project = { sessions: new Map(), files: new Set(), generation: 0, timer: undefined, watcher: undefined };
        project.watcher = watch(session.projectRoot, { recursive: true }, (_event, filename) => {
          if (!relevant(filename)) return;
          project.files.add(String(filename));
          if (project.timer !== undefined) cancel(project.timer);
          project.timer = schedule(() => {
            project.timer = undefined;
            project.generation += 1;
            const files = [...project.files]; project.files.clear();
            return Promise.all([...project.sessions.values()].map(active => notify(active, project.generation, undefined, files)));
          }, 120);
          project.timer?.unref?.();
        });
        project.watcher.on?.('error', error => {
          for (const active of project.sessions.values()) void notify(active, ++project.generation, error, []);
        });
        project.watcher.unref?.();
        projects.set(session.projectRoot, project);
      }
      project.sessions.set(session.scope, session);
    },
    close(session) {
      const project = projects.get(session.projectRoot);
      if (!project) return;
      project.sessions.delete(session.scope);
      if (project.sessions.size) return;
      if (project.timer !== undefined) cancel(project.timer);
      project.watcher.close();
      projects.delete(session.projectRoot);
    },
    dispose() {
      for (const project of projects.values()) {
        if (project.timer !== undefined) cancel(project.timer);
        project.watcher.close();
      }
      projects.clear();
    },
  };
}
