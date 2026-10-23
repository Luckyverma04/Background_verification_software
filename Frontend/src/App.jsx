import { BrowserRouter, Outlet, Route, Routes } from "react-router-dom";
import Sidebar from "./layout/Sidebar";
import Topbar from "./layout/Topbar";
import Dashboard from "./pages/Dashboard";
import Candidates from "./pages/Candidates";
import CandidateDetail from "./pages/CandidateDetail";
import AddCandidate from "./pages/AddCandidate/AddCandidate";
import SheetImport from "./pages/SheetImport";
import Runs from "./pages/Runs";
import RunReview from "./pages/RunReview";
import "./App.css";

function Layout() {
  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <Topbar />
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="candidates" element={<Candidates />} />
          <Route path="candidates/new" element={<AddCandidate />} />
          <Route path="candidates/:id" element={<CandidateDetail />} />
          <Route path="sheet-import" element={<SheetImport />} />
          <Route path="runs" element={<Runs />} />
          <Route path="runs/:id" element={<RunReview />} />
          <Route path="*" element={<div className="state">Page not found</div>} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
