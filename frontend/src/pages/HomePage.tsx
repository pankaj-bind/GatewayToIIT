/**
 * HomePage Component
 * Main dashboard — welcoming, visual, and dead-simple to use
 */
import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import { useTheme } from '../hooks/useTheme';
import { useToast } from '../context/ToastContext';
import { slugify } from '../utils/slugify';
import { stringToColor } from '../utils/colors';
import axiosInstance from '../api/axiosInstance';
import {
  Search,
  Plus,
  ChevronDown,
  ChevronRight,
  Folder,
  Building2,
  Trash2,
  Edit2,
  ArrowRight,
  X,
  Image as ImageIcon,
  Calendar,
  Clock,
  CheckCircle,
  Video,
  RefreshCw,
  FileText,
  Layers,
} from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════════ */
interface Organization {
  id: number;
  name: string;
  slug?: string;
  logo: string | null;
  logo_url?: string | null;
  credential_count: number;
  video_count?: number;
  chapter_count?: number;
  pdf_count?: number;
}

interface Category {
  id: number;
  name: string;
  slug?: string;
  organizations: Organization[];
  organization_count: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CATEGORY MODAL
   ═══════════════════════════════════════════════════════════════════════ */
const CategoryModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
  initialValue?: string;
  title: string;
}> = ({ isOpen, onClose, onSave, initialValue = '', title }) => {
  const [name, setName] = useState(initialValue);
  useEffect(() => { setName(initialValue); }, [initialValue, isOpen]);
  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) { onSave(name.trim()); setName(''); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button onClick={onClose} className="modal-close"><X size={20} /></button>
        </div>
        <form onSubmit={handleSubmit} className="modal-form">
          <div className="form-group">
            <label htmlFor="category-name">Category Name</label>
            <input id="category-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Computer Science" autoFocus required />
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose} className="modal-btn modal-btn--secondary">Cancel</button>
            <button type="submit" className="modal-btn modal-btn--primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   ORGANIZATION MODAL
   ═══════════════════════════════════════════════════════════════════════ */
const OrganizationModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string, logo: File | null) => void;
  initialName?: string;
  initialLogo?: string | null;
  title: string;
}> = ({ isOpen, onClose, onSave, initialName = '', initialLogo, title }) => {
  const [name, setName] = useState(initialName);
  const [logo, setLogo] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(initialLogo || null);

  useEffect(() => { setName(initialName); setLogoPreview(initialLogo || null); }, [initialName, initialLogo, isOpen]);
  if (!isOpen) return null;

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setLogo(file);
      const reader = new FileReader();
      reader.onloadend = () => setLogoPreview(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) { onSave(name.trim(), logo); setName(''); setLogo(null); setLogoPreview(null); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button onClick={onClose} className="modal-close"><X size={20} /></button>
        </div>
        <form onSubmit={handleSubmit} className="modal-form">
          <div className="form-group">
            <label htmlFor="org-name">Organization Name</label>
            <input id="org-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Digital Logic" autoFocus required />
          </div>
          <div className="form-group">
            <label>Logo (Optional)</label>
            <div className="logo-upload">
              {logoPreview ? (
                <div className="logo-preview">
                  <img src={logoPreview} alt="Logo preview" />
                  <button type="button" onClick={() => { setLogo(null); setLogoPreview(null); }} className="logo-remove"><X size={16} /></button>
                </div>
              ) : (
                <label htmlFor="logo-upload" className="logo-upload-btn">
                  <ImageIcon size={24} />
                  <span>Upload Logo</span>
                  <input id="logo-upload" type="file" accept="image/*" onChange={handleLogoChange} style={{ display: 'none' }} />
                </label>
              )}
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose} className="modal-btn modal-btn--secondary">Cancel</button>
            <button type="submit" className="modal-btn modal-btn--primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   WELCOME BAR — Compact greeting + quick stats + schedule peek
   ═══════════════════════════════════════════════════════════════════════ */
interface ScheduleItem {
  id: string;
  time: string;
  endTime?: string;
  subject: string;
  description?: string;
  status: 'completed' | 'current' | 'upcoming';
}

const todayKey = () => {
  const d = new Date();
  return `sv-schedule:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const to12h = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${(h % 12 || 12)}:${m.toString().padStart(2, '0')} ${suffix}`;
};

const WelcomeBar: React.FC<{ catCount: number; orgCount: number; vidCount: number }> = ({ catCount, orgCount, vidCount }) => {
  const today = new Date();
  const greeting = today.getHours() < 12 ? 'Good morning' : today.getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const [nextEvent, setNextEvent] = useState<ScheduleItem | null>(null);
  const [scheduleCount, setScheduleCount] = useState(0);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(todayKey());
      if (raw) {
        const items = (JSON.parse(raw) as ScheduleItem[]).sort((a, b) => a.time.localeCompare(b.time));
        setScheduleCount(items.length);
        const upcoming = items.find((s) => s.status === 'current' || s.status === 'upcoming');
        if (upcoming) setNextEvent(upcoming);
      }
    } catch { /* ignore */ }
  }, []);

  return (
    <section className="welcome-bar">
      <div className="welcome-left">
        <h1 className="welcome-greeting">{greeting}!</h1>
        <p className="welcome-date">{dateStr}</p>
      </div>

      <div className="welcome-chips">
        <div className="welcome-chip">
          <Folder size={14} />
          <span className="welcome-chip-num">{catCount}</span>
          <span className="welcome-chip-label">{catCount === 1 ? 'Category' : 'Categories'}</span>
        </div>
        <div className="welcome-chip">
          <Building2 size={14} />
          <span className="welcome-chip-num">{orgCount}</span>
          <span className="welcome-chip-label">{orgCount === 1 ? 'Org' : 'Orgs'}</span>
        </div>
        <div className="welcome-chip">
          <Video size={14} />
          <span className="welcome-chip-num">{vidCount}</span>
          <span className="welcome-chip-label">{vidCount === 1 ? 'Video' : 'Videos'}</span>
        </div>
      </div>

      <div className="welcome-schedule">
        {nextEvent ? (
          <Link to="/schedule" className="welcome-event">
            <Clock size={14} className="welcome-event-icon" />
            <span className="welcome-event-label">Next:</span>
            <span className="welcome-event-time">{to12h(nextEvent.time)}</span>
            <span className="welcome-event-name">{nextEvent.subject}</span>
            <ArrowRight size={13} />
          </Link>
        ) : scheduleCount > 0 ? (
          <Link to="/schedule" className="welcome-event welcome-event--done">
            <CheckCircle size={14} />
            <span>All done for today!</span>
            <ArrowRight size={13} />
          </Link>
        ) : (
          <Link to="/schedule" className="welcome-event welcome-event--empty">
            <Calendar size={14} />
            <span>Plan your day</span>
            <ArrowRight size={13} />
          </Link>
        )}
      </div>
    </section>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN HOME PAGE
   ═══════════════════════════════════════════════════════════════════════ */
const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { addToast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);

  const [categoryModal, setCategoryModal] = useState<{ isOpen: boolean; editId?: number; initialName?: string }>({ isOpen: false });
  const [orgModal, setOrgModal] = useState<{ isOpen: boolean; categoryId?: number; editId?: number; initialName?: string; initialLogo?: string | null }>({ isOpen: false });
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'category' | 'org'; id: number; name: string } | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => { fetchCategories(); }, []);

  const fetchCategories = async () => {
    try {
      setIsLoading(true);
      const response = await axiosInstance.get('/api/vault/categories/');
      setCategories(response.data);
      setExpandedCategories(new Set(response.data.map((cat: Category) => cat.id)));
    } catch (error) {
      console.error('Failed to fetch categories:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleCategory = (categoryId: number) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      next.has(categoryId) ? next.delete(categoryId) : next.add(categoryId);
      return next;
    });
  };

  // ── Category CRUD ──
  const handleCreateCategory = async (name: string) => {
    try {
      const response = await axiosInstance.post('/api/vault/categories/', { name });
      await fetchCategories();
      setCategoryModal({ isOpen: false });

      const imported = response.data?.imported;
      if (imported && (imported.orgs || imported.chapters || imported.videos || imported.pdfs)) {
        const parts = [];
        if (imported.orgs) parts.push(`${imported.orgs} org${imported.orgs > 1 ? 's' : ''}`);
        if (imported.chapters) parts.push(`${imported.chapters} chapter${imported.chapters > 1 ? 's' : ''}`);
        if (imported.videos) parts.push(`${imported.videos} video${imported.videos > 1 ? 's' : ''}`);
        if (imported.pdfs) parts.push(`${imported.pdfs} PDF${imported.pdfs > 1 ? 's' : ''}`);
        addToast(`Category created — imported ${parts.join(', ')} from Drive`, 'success');
      } else {
        addToast('Category created', 'success');
      }
    } catch (error: any) {
      addToast(error.response?.data?.name?.[0] || 'Failed to create category', 'error');
    }
  };

  const handleUpdateCategory = async (name: string) => {
    if (!categoryModal.editId) return;
    try {
      await axiosInstance.patch(`/api/vault/categories/${categoryModal.editId}/`, { name });
      await fetchCategories();
      setCategoryModal({ isOpen: false });
      addToast('Category updated', 'success');
    } catch (error: any) {
      addToast(error.response?.data?.name?.[0] || 'Failed to update', 'error');
    }
  };

  const handleDeleteCategory = async (id: number) => {
    try {
      await axiosInstance.delete(`/api/vault/categories/${id}/`);
      await fetchCategories();
      addToast('Category deleted', 'success');
    } catch {
      addToast('Failed to delete category', 'error');
    }
  };

  // ── Organization CRUD ──
  const handleCreateOrganization = async (name: string, logo: File | null) => {
    if (!orgModal.categoryId) return;
    try {
      const fd = new FormData();
      fd.append('name', name);
      fd.append('category', orgModal.categoryId.toString());
      if (logo) fd.append('logo', logo);
      await axiosInstance.post('/api/vault/organizations/', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await fetchCategories();
      setOrgModal({ isOpen: false });
      addToast('Organization created', 'success');
    } catch (error: any) {
      addToast(error.response?.data?.non_field_errors?.[0] || 'Failed to create', 'error');
    }
  };

  const handleUpdateOrganization = async (name: string, logo: File | null) => {
    if (!orgModal.editId) return;
    try {
      const fd = new FormData();
      fd.append('name', name);
      if (orgModal.categoryId) fd.append('category', orgModal.categoryId.toString());
      if (logo) fd.append('logo', logo);
      await axiosInstance.patch(`/api/vault/organizations/${orgModal.editId}/`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await fetchCategories();
      setOrgModal({ isOpen: false });
      addToast('Organization updated', 'success');
    } catch (error: any) {
      addToast(error.response?.data?.non_field_errors?.[0] || 'Failed to update', 'error');
    }
  };

  const handleDeleteOrganization = async (id: number) => {
    try {
      await axiosInstance.delete(`/api/vault/organizations/${id}/`);
      await fetchCategories();
      addToast('Organization deleted', 'success');
    } catch {
      addToast('Failed to delete', 'error');
    }
  };

  const confirmDelete = () => {
    if (!deleteConfirm) return;
    if (deleteConfirm.type === 'category') handleDeleteCategory(deleteConfirm.id);
    else handleDeleteOrganization(deleteConfirm.id);
    setDeleteConfirm(null);
  };

  // ── Sync with Google Drive ──
  const handleSyncAll = async () => {
    try {
      setIsSyncing(true);
      const response = await axiosInstance.post('/api/vault/sync-all/');
      await fetchCategories();
      
      const {
        videos_synced, videos_deleted, pdfs_synced, pdfs_deleted,
        orgs_created = 0, chapters_created = 0, errors,
      } = response.data;

      if (errors && errors.length > 0) {
        addToast(`Sync completed with ${errors.length} error(s)`, 'error');
      } else {
        const parts = [];
        if (orgs_created) parts.push(`+${orgs_created} org${orgs_created > 1 ? 's' : ''}`);
        if (chapters_created) parts.push(`+${chapters_created} chapter${chapters_created > 1 ? 's' : ''}`);
        if (videos_synced) parts.push(`+${videos_synced} video${videos_synced > 1 ? 's' : ''}`);
        if (pdfs_synced) parts.push(`+${pdfs_synced} PDF${pdfs_synced > 1 ? 's' : ''}`);
        const removed = videos_deleted + pdfs_deleted;
        if (removed) parts.push(`-${removed} removed`);
        if (parts.length) {
          addToast(`Synced: ${parts.join(', ')}`, 'success');
        } else {
          addToast('Everything is up to date', 'info');
        }
      }
    } catch (error: any) {
      addToast(error.response?.data?.error || 'Sync failed', 'error');
    } finally {
      setIsSyncing(false);
    }
  };

  // ── Filtering & stats ──
  const filteredCategories = categories.filter((cat) =>
    cat.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    cat.organizations.some((org) => org.name.toLowerCase().includes(searchQuery.toLowerCase())),
  );

  const totalOrgs = categories.reduce((sum, c) => sum + c.organizations.length, 0);
  const totalVideos = categories.reduce((sum, c) => sum + c.organizations.reduce((s, o) => s + (o.video_count ?? 0), 0), 0);

  return (
    <div className="home-page">
      <Navbar theme={theme} onThemeToggle={toggleTheme} />

      <main className="home-main" id="main-content">
        <div className="home-container">

          {/* ── Welcome Bar ── */}
          <WelcomeBar catCount={categories.length} orgCount={totalOrgs} vidCount={totalVideos} />

          {/* ── Toolbar ── */}
          <div className="home-toolbar">
            <div className="home-search">
              <Search size={18} className="home-search-icon" />
              <input
                type="text"
                placeholder="Search categories or organizations…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="home-search-input"
              />
              {searchQuery && (
                <button className="home-search-clear" onClick={() => setSearchQuery('')}><X size={14} /></button>
              )}
            </div>
            <button
              onClick={handleSyncAll}
              className="home-btn home-btn--icon"
              disabled={isSyncing}
              title={isSyncing ? 'Syncing…' : 'Sync with Google Drive'}
              aria-label="Sync with Google Drive"
            >
              <RefreshCw size={18} className={isSyncing ? 'spin-animation' : ''} />
            </button>
            <button
              onClick={() => setCategoryModal({ isOpen: true })}
              className="home-btn home-btn--primary"
              title="New category"
              aria-label="New category"
            >
              <Plus size={18} />
              <span className="home-btn-label">New Category</span>
            </button>
          </div>

          {/* ── Categories ── */}
          <div className="home-content">
            {isLoading ? (
              <div className="home-loading"><div className="loading-spinner" /><p>Loading your workspace…</p></div>
            ) : filteredCategories.length === 0 ? (
              <div className="home-empty">
                <div className="home-empty-icon"><Folder size={40} /></div>
                <h3>{searchQuery ? 'No results found' : 'No categories yet'}</h3>
                <p>{searchQuery ? `Nothing matches "${searchQuery}"` : 'Create your first category to organize your learning'}</p>
                {!searchQuery && (
                  <button onClick={() => setCategoryModal({ isOpen: true })} className="home-btn home-btn--primary" style={{ marginTop: '1rem' }}>
                    <Plus size={18} /> Create Category
                  </button>
                )}
              </div>
            ) : (
              <div className="home-categories">
                {filteredCategories.map((category) => {
                  const isExpanded = expandedCategories.has(category.id);
                  return (
                    <div key={category.id} className={`cat-card${isExpanded ? ' cat-card--open' : ''}`}>
                      {/* Category header */}
                      <div className="cat-header">
                        <button onClick={() => toggleCategory(category.id)} className="cat-toggle">
                          <span className="cat-chevron">{isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</span>
                          <Folder size={18} className="cat-folder-icon" />
                          <span className="cat-name">{category.name}</span>
                          <span className="cat-count">{category.organization_count} org{category.organization_count !== 1 ? 's' : ''}</span>
                        </button>

                        <div className="cat-actions">
                          <button onClick={() => setOrgModal({ isOpen: true, categoryId: category.id })} className="cat-action cat-action--add" title="Add organization">
                            <Plus size={15} /> <span>Add</span>
                          </button>
                          <button onClick={() => setCategoryModal({ isOpen: true, editId: category.id, initialName: category.name })} className="cat-action" title="Edit"><Edit2 size={15} /></button>
                          <button onClick={() => setDeleteConfirm({ type: 'category', id: category.id, name: category.name })} className="cat-action cat-action--danger" title="Delete"><Trash2 size={15} /></button>
                        </div>
                      </div>

                      {/* Organizations */}
                      {isExpanded && (
                        <div className="org-grid">
                          {category.organizations.length === 0 ? (
                            <div className="org-empty-state">
                                <span className="org-empty-text">No organizations here yet.</span>
                                <button className="org-empty-btn" onClick={() => setOrgModal({ isOpen: true, categoryId: category.id })}>
                                  <Plus size={14} /> Add one
                                </button>
                            </div>
                          ) : (
                              category.organizations.map((org) => (
                                <div
                                  key={org.id}
                                  className="org-card"
                                  style={{ '--org-color': stringToColor(org.name) } as React.CSSProperties}
                                  onClick={() => navigate(`/${category.slug || slugify(category.name)}/${org.slug || slugify(org.name)}`)}
                                >
                                  <div className="org-card-accent" />
                                  <div className="org-card-top">
                                    <div className="org-avatar" style={{ color: 'var(--org-color)' }}>
                                      {org.logo_url ? <img src={org.logo_url} alt="" /> : <Building2 size={22} />}
                                    </div>
                                    <div className="org-card-info">
                                      <h4 className="org-card-name">{org.name}</h4>
                                      <div className="org-card-stats">
                                        <span className="org-stat" title={`${org.chapter_count ?? 0} chapter${(org.chapter_count ?? 0) === 1 ? '' : 's'}`}>
                                          <Layers size={12} />
                                          {org.chapter_count ?? 0}
                                        </span>
                                        {(org.video_count ?? 0) > 0 && (
                                          <span className="org-stat" title={`${org.video_count} video${org.video_count === 1 ? '' : 's'}`}>
                                            <Video size={12} />
                                            {org.video_count}
                                          </span>
                                        )}
                                        {(org.pdf_count ?? 0) > 0 && (
                                          <span className="org-stat" title={`${org.pdf_count} PDF${org.pdf_count === 1 ? '' : 's'}`}>
                                            <FileText size={12} />
                                            {org.pdf_count}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="org-card-actions">
                                    <button onClick={(e) => { e.stopPropagation(); setOrgModal({ isOpen: true, categoryId: category.id, editId: org.id, initialName: org.name, initialLogo: org.logo_url || null }); }} className="org-mini-btn" title="Edit"><Edit2 size={13} /></button>
                                    <button onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ type: 'org', id: org.id, name: org.name }); }} className="org-mini-btn org-mini-btn--danger" title="Delete"><Trash2 size={13} /></button>
                                  </div>
                                </div>
                              ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* ── Delete Confirmation ── */}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal-content modal-content--narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Delete {deleteConfirm.type === 'category' ? 'Category' : 'Organization'}</h3>
              <button onClick={() => setDeleteConfirm(null)} className="modal-close"><X size={20} /></button>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 1.5rem' }}>
                Are you sure you want to delete <strong style={{ color: 'var(--text-primary)' }}>{deleteConfirm.name}</strong>?
                {deleteConfirm.type === 'category' && ' All organizations inside it will also be deleted.'}
                {' '}This cannot be undone.
              </p>
            </div>
            <div className="modal-actions">
              <button onClick={() => setDeleteConfirm(null)} className="modal-btn modal-btn--secondary">Cancel</button>
              <button onClick={confirmDelete} className="modal-btn modal-btn--danger">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      <CategoryModal isOpen={categoryModal.isOpen} onClose={() => setCategoryModal({ isOpen: false })} onSave={categoryModal.editId ? handleUpdateCategory : handleCreateCategory} initialValue={categoryModal.initialName} title={categoryModal.editId ? 'Edit Category' : 'New Category'} />
      <OrganizationModal isOpen={orgModal.isOpen} onClose={() => setOrgModal({ isOpen: false })} onSave={orgModal.editId ? handleUpdateOrganization : handleCreateOrganization} initialName={orgModal.initialName} initialLogo={orgModal.initialLogo} title={orgModal.editId ? 'Edit Organization' : 'New Organization'} />
    </div>
  );
};

export default HomePage;
