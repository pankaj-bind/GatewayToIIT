/**
 * Navbar Component
 * Minimal, professional navigation bar - blends with dark graphite theme
 */
import React from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Sun, Moon, LogOut, LogIn, Calendar, LayoutDashboard, User } from 'lucide-react';

const PlayLogo: React.FC<{ className?: string }> = ({ className }) => (
  <img
    src="/safevideo-icon.png"
    alt="SafeVideo"
    className={className}
    style={{ width: 28, height: 28 }}
  />
);

interface NavbarProps {
  theme: 'light' | 'dark';
  onThemeToggle: () => void;
}

const Navbar: React.FC<NavbarProps> = ({ theme, onThemeToggle }) => {
  const { isAuthenticated, user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = async () => {
    await logout();
  };

  const handleLogin = () => {
    navigate('/login');
  };

  const isActive = (path: string) => location.pathname === path;

  return (
    <header className="navbar">
      <div className="navbar__container">
        {/* Brand */}
        <Link to={isAuthenticated ? '/home' : '/'} className="navbar__brand">
          <PlayLogo className="navbar__logo" />
          <span className="navbar__title">SafeVideo</span>
        </Link>

        {/* Nav links for authenticated users */}
        {isAuthenticated && (
          <nav className="navbar__nav">
            <Link to="/home" className={`navbar__link${isActive('/home') ? ' navbar__link--active' : ''}`}>
              <LayoutDashboard size={16} />
              <span>Home</span>
            </Link>
            <Link to="/schedule" className={`navbar__link${isActive('/schedule') ? ' navbar__link--active' : ''}`}>
              <Calendar size={16} />
              <span>Schedule</span>
            </Link>
            <Link to="/profile" className={`navbar__link${isActive('/profile') ? ' navbar__link--active' : ''}`}>
              <User size={16} />
              <span>Profile</span>
            </Link>
          </nav>
        )}

        {/* Actions */}
        <div className="navbar__actions">
          {/* Theme Toggle */}
          <button
            onClick={onThemeToggle}
            className="btn btn--ghost btn--icon"
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>

          {/* Auth */}
          {isAuthenticated ? (
            <>
              <span className="navbar__user">
                <strong>{user?.username}</strong>
              </span>
              <button onClick={handleLogout} className="btn btn--ghost">
                <LogOut size={16} />
                <span>Logout</span>
              </button>
            </>
          ) : (
            <button onClick={handleLogin} className="btn btn--primary">
              <LogIn size={16} />
              <span>Sign in</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};

export default Navbar;
