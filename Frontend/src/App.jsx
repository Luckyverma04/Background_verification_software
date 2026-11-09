import { useState } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import Sidebar from "./layout/Sidebar";
import Topbar from "./layout/Topbar";
import Dashboard from "./pages/Dashboard";
import Candidates from "./pages/Candidates";
import CandidateDetail from "./pages/CandidateDetail";
import AddCandidate from "./pages/AddCandidate/AddCandidate";
import SheetImport from "./pages/SheetImport";
import Runs from "./pages/Runs";
import RunReview from "./pages/RunReview";
import Login from "./pages/Login";
import Account from "./pages/Account";
import Users from "./pages/Users";
import { Empty, Loading } from "./components/ui";
import "./App.css";

// Pages inside the app need a logged-in user
function RequireAuth({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined) return <div className="content"><Loading text="Checking login…" /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return children;
}

function AdminOnly({ children }) {
  const { user } = useAuth();
  return user?.role === "ADMIN" ? children : <Empty icon="lock" title="Admins only">Ask an admin if you need access to this page.</Empty>;
}

function Layout() {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className={`shell ${navOpen ? "nav-open" : ""}`} onClick={(e) => { if (navOpen && e.target === e.currentTarget) setNavOpen(false); }}>
      <Sidebar onNavigate={() => setNavOpen(false)} />
      <div className="main" onClick={() => navOpen && setNavOpen(false)}>
        <Topbar onMenu={(e) => { e.stopPropagation(); setNavOpen(true); }} />
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
    <BrowserRouter>
      <Routes>
        <Route path="login" element={<Login />} />
        <Route element={<RequireAuth><Layout /></RequireAuth>}>
          <Route index element={<Dashboard />} />
          <Route path="candidates" element={<Candidates />} />
          <Route path="candidates/new" element={<AddCandidate />} />
          <Route path="candidates/:id" element={<CandidateDetail />} />
          <Route path="sheet-import" element={<SheetImport />} />
          <Route path="runs" element={<Runs />} />
          <Route path="runs/:id" element={<RunReview />} />
          <Route path="account" element={<Account />} />
          <Route path="users" element={<AdminOnly><Users /></AdminOnly>} />
          <Route path="*" element={<Empty icon="search" title="Page not found">This page does not exist.</Empty>} />
        </Route>
      </Routes>
    </BrowserRouter>
    </AuthProvider>
  );
}
