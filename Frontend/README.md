# BGV Automation – Frontend

React 19 + Vite UI for BGV Automation. Setup, configuration and usage are in the [main README](../README.md).

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
npm run lint     # oxlint
```

The API address defaults to `http://localhost:5000/api`; set `VITE_API_URL` in `Frontend/.env` to change it.

| Folder | Contents |
|---|---|
| `src/pages/` | Dashboard, Candidates, Candidate detail, Add candidate, Runs, Run review, Google Sheet, Users, Account, Login |
| `src/components/` | UI kit (`ui.jsx`), icons (`Icon.jsx`), known-profiles panel |
| `src/layout/` | sidebar and top bar |
| `src/auth/` | login state (`AuthContext`) |
| `src/api/client.js` | every API call; adds the login token and logs out on 401 |
| `src/index.css`, `src/App.css` | design tokens (light / dark) and component styles |
