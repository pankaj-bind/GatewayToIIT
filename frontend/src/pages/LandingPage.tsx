/**
 * LandingPage Component
 * Minimalist login portal - personal learning platform aesthetic
 */
import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ArrowRight } from 'lucide-react';

const LandingPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useAuth();

  // Redirect to home if already authenticated
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate('/home');
    }
  }, [isAuthenticated, isLoading, navigate]);

  if (isLoading) {
    return (
      <div className="landing-loading">
        <div className="landing-loader" />
      </div>
    );
  }

  return (
    <div className="landing">
      {/* Minimal Header */}
      <header className="landing__header">
        <div className="landing__logo">
          <img
            src="/safevideo-icon.png"
            alt="SafeVideo"
            className="landing__logo-icon"
          />
          <span className="landing__logo-text">SafeVideo</span>
        </div>
      </header>

      {/* Centered Content */}
      <main className="landing__main">
        <div className="landing__content">
          <h1 className="landing__title">
            Your personal
            <br />
            <span className="landing__highlight">learning vault</span>
          </h1>
          
          <p className="landing__subtitle">
            A private space for your educational content.
            <br />
            Organized. Annotated. Yours.
          </p>

          {/* CTA Buttons */}
          <div className="landing__actions">
            <button 
              onClick={() => navigate('/login')} 
              className="landing__btn landing__btn--primary"
            >
              Sign in
              <ArrowRight size={16} />
            </button>
            <button 
              onClick={() => navigate('/signup')} 
              className="landing__btn landing__btn--ghost"
            >
              Create account
            </button>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="landing__footer">
        <p>Built for focused learning</p>
      </footer>
    </div>
  );
};

export default LandingPage;
