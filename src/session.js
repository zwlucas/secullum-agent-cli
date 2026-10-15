/**
 * session.js - Manages local persistence of Secullum Cloud authentication
 * tokens, user profile, active database, and added equipment IDs.
 * Completely standalone, zero external dependencies.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function getSessionFilePath() {
  const home = os.homedir() || process.cwd();
  return path.join(home, '.secullum-agent-session.json');
}

/**
 * Load the saved cloud session from disk.
 * @returns {object|null}
 */
function loadSession() {
  const p = getSessionFilePath();
  if (!fs.existsSync(p)) return null;

  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Save or update cloud session data on disk.
 * @param {object} data
 * @returns {object}
 */
function saveSession(data) {
  const p = getSessionFilePath();
  const current = loadSession() || {};
  const updated = { ...current, ...data, updatedAt: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

/**
 * Clear the current session.
 */
function clearSession() {
  const p = getSessionFilePath();
  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

/**
 * Retrieve list of equipment IDs configured to be active on this agent machine.
 * @returns {number[]}
 */
function getAddedEquipmentIds() {
  const session = loadSession();
  return session?.equipamentosAdicionados || [];
}

/**
 * Add an equipment ID to the active equipment list.
 * @param {number|string} id
 * @returns {number[]}
 */
function addEquipmentId(id) {
  const numId = Number(id);
  const current = getAddedEquipmentIds();
  if (!current.includes(numId)) {
    current.push(numId);
    saveSession({ equipamentosAdicionados: current });
  }
  return current;
}

/**
 * Remove an equipment ID from the active equipment list.
 * @param {number|string} id
 * @returns {number[]}
 */
function removeEquipmentId(id) {
  const numId = Number(id);
  const current = getAddedEquipmentIds();
  const updated = current.filter((x) => x !== numId);
  saveSession({ equipamentosAdicionados: updated });
  return updated;
}

/**
 * Check if an equipment is added to this agent machine.
 * @param {number|string} id
 * @returns {boolean}
 */
function isEquipmentAdded(id) {
  const numId = Number(id);
  return getAddedEquipmentIds().includes(numId);
}

module.exports = {
  getSessionFilePath,
  loadSession,
  saveSession,
  clearSession,
  getAddedEquipmentIds,
  addEquipmentId,
  removeEquipmentId,
  isEquipmentAdded,
};
