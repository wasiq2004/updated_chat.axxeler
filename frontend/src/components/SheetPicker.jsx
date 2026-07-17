import { useState, useEffect } from 'react';
import { api } from '../api.js';

/**
 * account → spreadsheet → tab → columns, for the automation builder.
 *
 * Shared by the Sheets nodes and the sheet-row trigger so the cascade exists
 * once. Headless: it owns the fetching and hands state back, because the builder
 * and the trigger panel style their fields very differently.
 *
 * The DRIVE SCOPE TRAP: listing a user's spreadsheets needs `drive.readonly`.
 * The narrower `drive.file` only surfaces files the app itself created, so an
 * account connected without the browse scope returns an EMPTY picker with no
 * explanation. The backend already 409s with code DRIVE_SCOPE_MISSING; this
 * surfaces it as "reconnect", never as a blank dropdown.
 */
/**
 * The saved sheet library: pick a spreadsheet+tab BY NAME.
 *
 * Deliberately returns a COPY of the resolved ids for the caller to spread onto
 * the node, rather than storing a reference to the library entry. So deleting an
 * entry can never break a flow that already uses it — it only disappears from
 * the picker. The trade-off, which the UI states: re-pointing an entry does NOT
 * retro-update flows already built on it.
 */
export function useSavedSheets() {
  const [saved, setSaved] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    api.savedSheets.list()
      .then(list => { if (alive) setSaved(list || []); })
      .catch(() => { if (alive) setSaved([]); })   // never break the builder over a picker
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  return { saved, loading };
}

/** The node fields a saved sheet resolves to. Spread onto the node — a copy. */
export function resolveSavedSheet(entry) {
  return {
    googleAccountId: entry.googleAccountId,
    spreadsheetId: entry.spreadsheetId,
    spreadsheetName: entry.spreadsheetName || entry.name,
    sheetName: entry.sheetName,
  };
}

export function useSheetPicker({ googleAccountId, spreadsheetId, sheetName }) {
  const [accounts, setAccounts] = useState([]);
  const [spreadsheets, setSpreadsheets] = useState([]);
  const [tabs, setTabs] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [scopeMissing, setScopeMissing] = useState(false);
  const [headerError, setHeaderError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    api.googleIntegrations.list()
      .then(list => { if (alive) setAccounts(list || []); })
      .catch(() => { if (alive) setAccounts([]); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!googleAccountId) { setSpreadsheets([]); setScopeMissing(false); return undefined; }
    let alive = true;
    setLoading(true);
    setScopeMissing(false);
    api.googleIntegrations.listSpreadsheets(googleAccountId)
      .then(list => { if (alive) setSpreadsheets(list || []); })
      .catch(err => {
        if (!alive) return;
        setSpreadsheets([]);
        // Detect it rather than render an unexplained empty dropdown.
        if (/reconnect|permission to list/i.test(err?.message || '')) setScopeMissing(true);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [googleAccountId]);

  useEffect(() => {
    if (!googleAccountId || !spreadsheetId) { setTabs([]); return undefined; }
    let alive = true;
    api.googleIntegrations.listTabs(googleAccountId, spreadsheetId)
      .then(list => { if (alive) setTabs(list || []); })
      .catch(() => { if (alive) setTabs([]); });
    return () => { alive = false; };
  }, [googleAccountId, spreadsheetId]);

  useEffect(() => {
    if (!googleAccountId || !spreadsheetId || !sheetName) { setHeaders([]); setHeaderError(''); return undefined; }
    let alive = true;
    setHeaderError('');
    api.googleIntegrations.listHeaders(googleAccountId, spreadsheetId, sheetName)
      .then(r => { if (alive) setHeaders(r.headers || []); })
      .catch(err => {
        if (!alive) return;
        setHeaders([]);
        // A tab with no header row is a real, fixable answer — say it.
        setHeaderError(err?.message || 'Could not read this tab’s columns.');
      });
    return () => { alive = false; };
  }, [googleAccountId, spreadsheetId, sheetName]);

  return { accounts, spreadsheets, tabs, headers, scopeMissing, headerError, loading };
}
