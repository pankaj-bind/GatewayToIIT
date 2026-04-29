/**
 * PDFReaderPage — Advanced PDF Viewer with Annotation Support
 * 
 * Features:
 * - Fast client-side rendering via pdf.js
 * - Virtualized page rendering (only visible pages rendered)
 * - Zoom controls (fit-width, fit-page, custom %)
 * - Smooth scrolling with page navigation
 * - Full-text search with highlight
 * - Text selection & copy
 * - Light/dark theme support
 * - Freehand drawing (mouse + touch)
 * - Text highlight annotations
 * - Sticky notes / comments
 * - Add text anywhere
 * - Basic shapes (rectangle, arrow, line)
 * - Color & thickness controls
 * - Undo / redo
 * - Erase annotations
 * - Save annotations to backend
 * - Responsive layout
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import Navbar from '../components/Navbar';
import { useTheme } from '../hooks/useTheme';
import axiosInstance from '../api/axiosInstance';
import { API_ENDPOINTS } from '../config/api.config';
import {
  ArrowLeft,
  ZoomIn,
  ZoomOut,
  Maximize,
  AlignJustify,
  ChevronUp,
  ChevronDown,
  Search,
  X,
  Pencil,
  Highlighter,
  StickyNote,
  Type,
  Square,
  ArrowUpRight,
  Minus,
  Undo2,
  Redo2,
  Eraser,
  Save,
  Palette,
  Loader2,
  MousePointer2,
  Trash2,
  Columns2,
  FileText,
} from 'lucide-react';
import type { PDFAnnotation } from '../types/models';
import '../styles/pdf-reader.css';

// Configure pdf.js worker — use local bundle via Vite ?url import
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// =============================================================================
// TYPES
// =============================================================================
type AnnotationTool = 'select' | 'draw' | 'highlight' | 'note' | 'text' | 'rectangle' | 'arrow' | 'line' | 'eraser';

interface DrawPoint { x: number; y: number; }

interface LocalAnnotation {
  id?: number;
  tempId: string;
  page: number;
  annotation_type: PDFAnnotation['annotation_type'];
  data: Record<string, any>;
  saved: boolean;
}

interface HistoryEntry {
  type: 'add' | 'remove';
  annotation: LocalAnnotation;
}

// =============================================================================
// CONSTANTS
// =============================================================================
const COLORS = ['#FFD700', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FF69B4', '#DDA0DD', '#F0F0F0', '#333333'];
const THICKNESSES = [2, 4, 6, 8, 12];

// =============================================================================
// PDF PAGE COMPONENT (Virtualized)
// =============================================================================
const PDFPage: React.FC<{
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  isVisible: boolean;
  searchText: string;
  annotations: LocalAnnotation[];
  activeTool: AnnotationTool;
  activeColor: string;
  activeThickness: number;
  onAddAnnotation: (ann: LocalAnnotation) => void;
  onRemoveAnnotation: (tempId: string) => void;
}> = ({ pdfDoc, pageNumber, scale, isVisible, searchText, annotations, activeTool, activeColor, activeThickness, onAddAnnotation, onRemoveAnnotation }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [isDrawing, setIsDrawing] = useState(false);
  const currentPathRef = useRef<DrawPoint[]>([]);
  const [shapeStart, setShapeStart] = useState<DrawPoint | null>(null);

  // Render the PDF page
  useEffect(() => {
    if (!isVisible || !canvasRef.current) return;

    let cancelled = false;
    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;

        const viewport = page.getViewport({ scale });
        const canvasEl = canvasRef.current!;
        canvasEl.width = viewport.width;
        canvasEl.height = viewport.height;
        setPageSize({ width: viewport.width, height: viewport.height });

        // Also size the annotation canvas
        if (annotationCanvasRef.current) {
          annotationCanvasRef.current.width = viewport.width;
          annotationCanvasRef.current.height = viewport.height;
        }

        await page.render({ canvas: canvasEl, viewport }).promise;

        // Render text layer for selection & search
        if (textLayerRef.current) {
          textLayerRef.current.innerHTML = '';
          textLayerRef.current.style.width = `${viewport.width}px`;
          textLayerRef.current.style.height = `${viewport.height}px`;

          const textContent = await page.getTextContent();
          if (cancelled) return;

          for (const item of textContent.items) {
            const textItem = item as any;
            if (!textItem.str) continue;

            const tx = pdfjsLib.Util.transform(
              viewport.transform,
              textItem.transform
            );

            const span = document.createElement('span');
            span.textContent = textItem.str;
            span.style.position = 'absolute';
            span.style.left = `${tx[4]}px`;
            span.style.top = `${tx[5] - textItem.height * scale}px`;
            span.style.fontSize = `${textItem.height * scale}px`;
            span.style.fontFamily = textItem.fontName || 'sans-serif';
            span.style.color = 'transparent';
            span.style.whiteSpace = 'pre';
            span.style.cursor = 'text';
            span.style.userSelect = 'text';

            // Highlight search matches
            if (searchText && textItem.str.toLowerCase().includes(searchText.toLowerCase())) {
              span.style.background = 'rgba(255, 255, 0, 0.4)';
            }

            textLayerRef.current!.appendChild(span);
          }
        }
      } catch (err) {
        if (!cancelled) console.error(`Error rendering page ${pageNumber}:`, err);
      }
    };

    renderPage();
    return () => { cancelled = true; };
  }, [pdfDoc, pageNumber, scale, isVisible, searchText]);

  // Redraw annotations on the annotation canvas
  useEffect(() => {
    if (!annotationCanvasRef.current || !pageSize.width) return;
    const ctx = annotationCanvasRef.current.getContext('2d')!;
    ctx.clearRect(0, 0, pageSize.width, pageSize.height);

    for (const ann of annotations) {
      const d = ann.data;
      ctx.save();

      if (ann.annotation_type === 'drawing' && d.paths) {
        ctx.strokeStyle = d.color || '#FF6B6B';
        ctx.lineWidth = d.thickness || 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (const path of d.paths) {
          if (path.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(path[0].x * pageSize.width, path[0].y * pageSize.height);
          for (let i = 1; i < path.length; i++) {
            ctx.lineTo(path[i].x * pageSize.width, path[i].y * pageSize.height);
          }
          ctx.stroke();
        }
      }

      if (ann.annotation_type === 'highlight' && d.rect) {
        ctx.fillStyle = (d.color || '#FFD700') + '55';
        ctx.fillRect(
          d.rect.x * pageSize.width,
          d.rect.y * pageSize.height,
          d.rect.w * pageSize.width,
          d.rect.h * pageSize.height
        );
      }

      if (ann.annotation_type === 'text' && d.position) {
        ctx.font = `${(d.fontSize || 14)}px Inter, sans-serif`;
        ctx.fillStyle = d.color || '#333333';
        ctx.fillText(d.text || '', d.position.x * pageSize.width, d.position.y * pageSize.height);
      }

      if (ann.annotation_type === 'shape') {
        ctx.strokeStyle = d.color || '#45B7D1';
        ctx.lineWidth = d.thickness || 3;
        ctx.lineCap = 'round';

        if (d.shapeType === 'rectangle' && d.rect) {
          ctx.strokeRect(
            d.rect.x * pageSize.width,
            d.rect.y * pageSize.height,
            d.rect.w * pageSize.width,
            d.rect.h * pageSize.height
          );
        }

        if (d.shapeType === 'line' && d.start && d.end) {
          ctx.beginPath();
          ctx.moveTo(d.start.x * pageSize.width, d.start.y * pageSize.height);
          ctx.lineTo(d.end.x * pageSize.width, d.end.y * pageSize.height);
          ctx.stroke();
        }

        if (d.shapeType === 'arrow' && d.start && d.end) {
          const sx = d.start.x * pageSize.width;
          const sy = d.start.y * pageSize.height;
          const ex = d.end.x * pageSize.width;
          const ey = d.end.y * pageSize.height;

          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(ex, ey);
          ctx.stroke();

          // Arrow head
          const angle = Math.atan2(ey - sy, ex - sx);
          const headLen = 12;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - headLen * Math.cos(angle - Math.PI / 6), ey - headLen * Math.sin(angle - Math.PI / 6));
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - headLen * Math.cos(angle + Math.PI / 6), ey - headLen * Math.sin(angle + Math.PI / 6));
          ctx.stroke();
        }
      }

      if (ann.annotation_type === 'note' && d.position) {
        const nx = d.position.x * pageSize.width;
        const ny = d.position.y * pageSize.height;

        ctx.fillStyle = d.color || '#FFD700';
        ctx.shadowColor = 'rgba(0,0,0,0.2)';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.roundRect(nx - 12, ny - 12, 24, 24, 4);
        ctx.fill();
        ctx.shadowColor = 'transparent';

        ctx.fillStyle = '#000';
        ctx.font = 'bold 14px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('📝', nx, ny);
      }

      ctx.restore();
    }
  }, [annotations, pageSize]);

  // Helper to get normalized coordinates
  const getNormCoords = (e: React.MouseEvent | React.TouchEvent): DrawPoint => {
    const rect = annotationCanvasRef.current!.getBoundingClientRect();
    let clientX: number, clientY: number;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height,
    };
  };

  const handlePointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    if (activeTool === 'select') return;
    e.preventDefault();

    const coords = getNormCoords(e);

    if (activeTool === 'eraser') {
      // Find annotation near click and remove it
      for (const ann of annotations) {
        if (ann.annotation_type === 'note' && ann.data.position) {
          const dx = Math.abs(ann.data.position.x - coords.x);
          const dy = Math.abs(ann.data.position.y - coords.y);
          if (dx < 0.03 && dy < 0.03) {
            onRemoveAnnotation(ann.tempId);
            return;
          }
        }
        if (ann.annotation_type === 'drawing' && ann.data.paths) {
          for (const path of ann.data.paths) {
            for (const pt of path) {
              if (Math.abs(pt.x - coords.x) < 0.02 && Math.abs(pt.y - coords.y) < 0.02) {
                onRemoveAnnotation(ann.tempId);
                return;
              }
            }
          }
        }
        if ((ann.annotation_type === 'highlight' || ann.annotation_type === 'shape') && ann.data.rect) {
          const r = ann.data.rect;
          if (coords.x >= r.x && coords.x <= r.x + r.w && coords.y >= r.y && coords.y <= r.y + r.h) {
            onRemoveAnnotation(ann.tempId);
            return;
          }
        }
        if (ann.annotation_type === 'text' && ann.data.position) {
          const dx = Math.abs(ann.data.position.x - coords.x);
          const dy = Math.abs(ann.data.position.y - coords.y);
          if (dx < 0.05 && dy < 0.02) {
            onRemoveAnnotation(ann.tempId);
            return;
          }
        }
      }
      return;
    }

    if (activeTool === 'draw') {
      setIsDrawing(true);
      currentPathRef.current = [coords];
    }

    if (activeTool === 'note') {
      const text = prompt('Enter note:');
      if (text) {
        onAddAnnotation({
          tempId: `ann_${Date.now()}_${Math.random()}`,
          page: pageNumber,
          annotation_type: 'note',
          data: { position: coords, text, color: activeColor },
          saved: false,
        });
      }
    }

    if (activeTool === 'text') {
      const text = prompt('Enter text:');
      if (text) {
        onAddAnnotation({
          tempId: `ann_${Date.now()}_${Math.random()}`,
          page: pageNumber,
          annotation_type: 'text',
          data: { position: coords, text, color: activeColor, fontSize: activeThickness * 3 },
          saved: false,
        });
      }
    }

    if (['highlight', 'rectangle', 'arrow', 'line'].includes(activeTool)) {
      setIsDrawing(true);
      setShapeStart(coords);
    }
  };

  const handlePointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return;
    e.preventDefault();

    if (activeTool === 'draw') {
      const coords = getNormCoords(e);
      currentPathRef.current.push(coords);

      // Live preview
      if (annotationCanvasRef.current && pageSize.width) {
        const ctx = annotationCanvasRef.current.getContext('2d')!;
        const path = currentPathRef.current;
        if (path.length >= 2) {
          const prev = path[path.length - 2];
          const curr = path[path.length - 1];
          ctx.strokeStyle = activeColor;
          ctx.lineWidth = activeThickness;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(prev.x * pageSize.width, prev.y * pageSize.height);
          ctx.lineTo(curr.x * pageSize.width, curr.y * pageSize.height);
          ctx.stroke();
        }
      }
    }
  };

  const handlePointerUp = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return;
    setIsDrawing(false);

    if (activeTool === 'draw' && currentPathRef.current.length > 1) {
      onAddAnnotation({
        tempId: `ann_${Date.now()}_${Math.random()}`,
        page: pageNumber,
        annotation_type: 'drawing',
        data: { paths: [currentPathRef.current], color: activeColor, thickness: activeThickness },
        saved: false,
      });
      currentPathRef.current = [];
    }

    if (shapeStart) {
      const coords = getNormCoords(e);
      const rect = {
        x: Math.min(shapeStart.x, coords.x),
        y: Math.min(shapeStart.y, coords.y),
        w: Math.abs(coords.x - shapeStart.x),
        h: Math.abs(coords.y - shapeStart.y),
      };

      if (activeTool === 'highlight' && rect.w > 0.005) {
        onAddAnnotation({
          tempId: `ann_${Date.now()}_${Math.random()}`,
          page: pageNumber,
          annotation_type: 'highlight',
          data: { rect, color: activeColor },
          saved: false,
        });
      }

      if (activeTool === 'rectangle' && rect.w > 0.005) {
        onAddAnnotation({
          tempId: `ann_${Date.now()}_${Math.random()}`,
          page: pageNumber,
          annotation_type: 'shape',
          data: { shapeType: 'rectangle', rect, color: activeColor, thickness: activeThickness },
          saved: false,
        });
      }

      if ((activeTool === 'line' || activeTool === 'arrow') && (rect.w > 0.005 || rect.h > 0.005)) {
        onAddAnnotation({
          tempId: `ann_${Date.now()}_${Math.random()}`,
          page: pageNumber,
          annotation_type: 'shape',
          data: { shapeType: activeTool, start: shapeStart, end: coords, color: activeColor, thickness: activeThickness },
          saved: false,
        });
      }

      setShapeStart(null);
    }
  };

  if (!isVisible) {
    return <div className="pdf-page-placeholder" style={{ height: pageSize.height || 800 }} data-page={pageNumber} />;
  }

  const toolCursor = activeTool === 'select' ? 'default' :
    activeTool === 'eraser' ? 'crosshair' :
    activeTool === 'text' || activeTool === 'note' ? 'text' :
    'crosshair';

  return (
    <div className="pdf-page" data-page={pageNumber} style={{ position: 'relative', width: pageSize.width || 'auto' }}>
      <canvas ref={canvasRef} className="pdf-page-canvas" />
      <div ref={textLayerRef} className="pdf-text-layer" />
      <canvas
        ref={annotationCanvasRef}
        className="pdf-annotation-canvas"
        style={{ cursor: toolCursor }}
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onMouseLeave={() => { if (isDrawing) { setIsDrawing(false); currentPathRef.current = []; setShapeStart(null); } }}
        onTouchStart={handlePointerDown}
        onTouchMove={handlePointerMove}
        onTouchEnd={handlePointerUp}
      />
      <div className="pdf-page-number">Page {pageNumber}</div>
    </div>
  );
};

// =============================================================================
// MAIN PDF READER COMPONENT
// =============================================================================
const PDFReaderPage: React.FC = () => {
  const params = useParams<{ pdfId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  const pdfId = (location.state as any)?.pdfId || parseInt(params.pdfId || '0');

  // State
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfInfo, setPdfInfo] = useState<{ title: string; totalPages: number; streamUrl: string }>({ title: '', totalPages: 0, streamUrl: '' });
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.0);
  const [fitMode, setFitMode] = useState<'width' | 'page' | 'custom'>('width');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set([1, 2]));
  const [viewMode, setViewMode] = useState<'single' | 'double'>('single');

  // Annotation state
  const [activeTool, setActiveTool] = useState<AnnotationTool>('select');
  const [activeColor, setActiveColor] = useState('#FFD700');
  const [activeThickness, setActiveThickness] = useState(4);
  const [annotations, setAnnotations] = useState<LocalAnnotation[]>([]);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showNotesPanel, setShowNotesPanel] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);

  // Fetch PDF info and load the document
  useEffect(() => {
    const loadPdf = async () => {
      try {
        setIsLoading(true);
        const res = await axiosInstance.get(API_ENDPOINTS.PDFS.DETAIL(pdfId));
        const info = res.data;
        setPdfInfo({ title: info.title, totalPages: info.page_count || 0, streamUrl: info.stream_url || '' });

        if (!info.stream_url) throw new Error('No stream URL for PDF');

        // Load PDF with pdf.js — use ranged/progressive loading so large files
        // don't hang waiting for the whole stream. disableAutoFetch lets us
        // render the first pages immediately and only fetch ranges as the
        // user scrolls. rangeChunkSize keeps each request small enough that
        // slow Drive streams don't trip the proxy idle timeout.
        const loadingTask = pdfjsLib.getDocument({
          url: info.stream_url,
          withCredentials: true,
          cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/cmaps/',
          cMapPacked: true,
          disableAutoFetch: true,
          disableStream: false,
          rangeChunkSize: 524288, // 512 KB
        });

        const doc = await loadingTask.promise;
        setPdfDoc(doc);
        setPdfInfo((prev) => ({ ...prev, totalPages: doc.numPages }));

        // Load existing annotations
        const annRes = await axiosInstance.get(API_ENDPOINTS.PDFS.ANNOTATIONS(pdfId));
        setAnnotations(annRes.data.map((a: any) => ({
          id: a.id,
          tempId: `server_${a.id}`,
          page: a.page,
          annotation_type: a.annotation_type,
          data: a.data,
          saved: true,
        })));
      } catch (err: any) {
        setError(err.message || 'Failed to load PDF');
      } finally {
        setIsLoading(false);
      }
    };

    if (pdfId) loadPdf();
  }, [pdfId]);

  // Observe visible pages via IntersectionObserver
  useEffect(() => {
    if (!scrollContainerRef.current || !pdfDoc) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const pageNum = parseInt((entry.target as HTMLElement).dataset.page || '0');
            if (!pageNum) continue;
            if (entry.isIntersecting) {
              next.add(pageNum);
              // Also pre-render adjacent pages
              if (pageNum > 1) next.add(pageNum - 1);
              if (pageNum < pdfDoc.numPages) next.add(pageNum + 1);
            } else {
              // Don't remove immediately — keep some buffer
              // Only remove if far from viewport
              if (entry.intersectionRatio === 0) {
                // Keep if within ±2 pages of any visible page
                const nearVisible = Array.from(next).some(
                  (vp) => Math.abs(vp - pageNum) <= 2
                );
                if (!nearVisible) next.delete(pageNum);
              }
            }
          }
          return next;
        });
      },
      { root: scrollContainerRef.current, rootMargin: '200px 0px', threshold: [0, 0.1] }
    );

    const pages = scrollContainerRef.current.querySelectorAll('[data-page]');
    pages.forEach((p) => observer.observe(p));

    return () => observer.disconnect();
  }, [pdfDoc, scale]);

  // Track current page from scroll position
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const pages = container.querySelectorAll('[data-page]');
      let closestPage = 1;
      let minDist = Infinity;

      pages.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const dist = Math.abs(rect.top - containerRect.top);
        if (dist < minDist) {
          minDist = dist;
          closestPage = parseInt((el as HTMLElement).dataset.page || '1');
        }
      });

      setCurrentPage(closestPage);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [pdfDoc]);

  // Fit mode calculation
  useEffect(() => {
    if (!scrollContainerRef.current || !pdfDoc || fitMode === 'custom') return;

    const computeScale = async () => {
      const page = await pdfDoc.getPage(1);
      const viewport = page.getViewport({ scale: 1.0 });
      const containerWidth = scrollContainerRef.current!.clientWidth - 48; // padding
      const containerHeight = scrollContainerRef.current!.clientHeight - 48;

      // In double mode, each page gets half the width (minus gap)
      const effectiveWidth = viewMode === 'double'
        ? (containerWidth - 16) / 2
        : containerWidth;

      if (fitMode === 'width') {
        setScale(effectiveWidth / viewport.width);
      } else if (fitMode === 'page') {
        const wScale = effectiveWidth / viewport.width;
        const hScale = containerHeight / viewport.height;
        setScale(Math.min(wScale, hScale));
      }
    };

    computeScale();
  }, [pdfDoc, fitMode, viewMode]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveAnnotations();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undoStack, redoStack, annotations]);

  // Navigation
  const goToPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(page, pdfInfo.totalPages));
    setCurrentPage(clamped);
    const el = scrollContainerRef.current?.querySelector(`[data-page="${clamped}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [pdfInfo.totalPages]);

  // Zoom
  const zoomIn = () => {
    setFitMode('custom');
    setScale((s) => Math.min(s * 1.25, 5.0));
  };

  const zoomOut = () => {
    setFitMode('custom');
    setScale((s) => Math.max(s / 1.25, 0.25));
  };

  // Annotation handlers
  const handleAddAnnotation = useCallback((ann: LocalAnnotation) => {
    setAnnotations((prev) => [...prev, ann]);
    setUndoStack((prev) => [...prev, { type: 'add', annotation: ann }]);
    setRedoStack([]);
  }, []);

  const handleRemoveAnnotation = useCallback((tempId: string) => {
    setAnnotations((prev) => {
      const ann = prev.find((a) => a.tempId === tempId);
      if (ann) {
        setUndoStack((u) => [...u, { type: 'remove', annotation: ann }]);
        setRedoStack([]);
      }
      return prev.filter((a) => a.tempId !== tempId);
    });
  }, []);

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const newStack = prev.slice(0, -1);

      if (last.type === 'add') {
        setAnnotations((a) => a.filter((x) => x.tempId !== last.annotation.tempId));
        setRedoStack((r) => [...r, last]);
      } else if (last.type === 'remove') {
        setAnnotations((a) => [...a, last.annotation]);
        setRedoStack((r) => [...r, last]);
      }

      return newStack;
    });
  }, []);

  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const newStack = prev.slice(0, -1);

      if (last.type === 'add') {
        setAnnotations((a) => [...a, last.annotation]);
        setUndoStack((u) => [...u, last]);
      } else if (last.type === 'remove') {
        setAnnotations((a) => a.filter((x) => x.tempId !== last.annotation.tempId));
        setUndoStack((u) => [...u, last]);
      }

      return newStack;
    });
  }, []);

  const handleSaveAnnotations = useCallback(async () => {
    setIsSaving(true);
    try {
      // Delete removed server annotations
      const serverIds = annotations.filter((a) => a.id).map((a) => a.id!);
      const existingRes = await axiosInstance.get(API_ENDPOINTS.PDFS.ANNOTATIONS(pdfId));
      const existingIds: number[] = existingRes.data.map((a: any) => a.id);

      for (const eid of existingIds) {
        if (!serverIds.includes(eid)) {
          await axiosInstance.delete(API_ENDPOINTS.PDFS.ANNOTATION_DETAIL(eid));
        }
      }

      // Save new annotations
      const unsaved = annotations.filter((a) => !a.saved);
      for (const ann of unsaved) {
        const res = await axiosInstance.post(API_ENDPOINTS.PDFS.ANNOTATIONS(pdfId), {
          page: ann.page,
          annotation_type: ann.annotation_type,
          data: ann.data,
        });
        ann.id = res.data.id;
        ann.saved = true;
      }

      setAnnotations([...annotations]);
    } catch (err) {
      console.error('Failed to save annotations:', err);
    } finally {
      setIsSaving(false);
    }
  }, [annotations, pdfId]);

  // Notes from annotations
  const noteAnnotations = useMemo(() =>
    annotations.filter((a) => a.annotation_type === 'note').sort((a, b) => a.page - b.page),
    [annotations]
  );

  // Annotation tools config
  const tools: { tool: AnnotationTool; icon: React.FC<any>; label: string }[] = [
    { tool: 'select', icon: MousePointer2, label: 'Select' },
    { tool: 'draw', icon: Pencil, label: 'Draw' },
    { tool: 'highlight', icon: Highlighter, label: 'Highlight' },
    { tool: 'note', icon: StickyNote, label: 'Note' },
    { tool: 'text', icon: Type, label: 'Text' },
    { tool: 'rectangle', icon: Square, label: 'Rectangle' },
    { tool: 'arrow', icon: ArrowUpRight, label: 'Arrow' },
    { tool: 'line', icon: Minus, label: 'Line' },
    { tool: 'eraser', icon: Eraser, label: 'Eraser' },
  ];

  if (isLoading) {
    return (
      <div className="yt-page">
        <Navbar theme={theme} onThemeToggle={toggleTheme} />
        <div className="org-videos-loading">
          <Loader2 size={48} className="spin-animation" />
          <p>Loading PDF...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="yt-page">
        <Navbar theme={theme} onThemeToggle={toggleTheme} />
        <div className="org-videos-loading">
          <p style={{ color: 'var(--color-error)' }}>{error}</p>
          <button className="btn btn--primary" onClick={() => navigate(-1)}>Go Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="yt-page pdf-reader-page">
      <Navbar theme={theme} onThemeToggle={toggleTheme} />

      {/* Top Toolbar */}
      <div className="pdf-toolbar">
        <div className="pdf-toolbar-left">
          <button className="btn btn--ghost btn--icon" onClick={() => navigate(-1)} title="Back">
            <ArrowLeft size={18} />
          </button>
          <span className="pdf-toolbar-title">{pdfInfo.title}</span>
        </div>

        <div className="pdf-toolbar-center">
          {/* Page navigation */}
          <button className="btn btn--ghost btn--icon-sm" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} title="Previous page">
            <ChevronUp size={16} />
          </button>
          <div className="pdf-page-input-wrap">
            <input
              ref={pageInputRef}
              type="number"
              className="pdf-page-input"
              value={currentPage}
              min={1}
              max={pdfInfo.totalPages}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                if (!isNaN(v)) goToPage(v);
              }}
            />
            <span className="pdf-page-total">/ {pdfInfo.totalPages}</span>
          </div>
          <button className="btn btn--ghost btn--icon-sm" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= pdfInfo.totalPages} title="Next page">
            <ChevronDown size={16} />
          </button>

          <div className="pdf-toolbar-divider" />

          {/* Zoom */}
          <button className="btn btn--ghost btn--icon-sm" onClick={zoomOut} title="Zoom out">
            <ZoomOut size={16} />
          </button>
          <span className="pdf-zoom-label">{Math.round(scale * 100)}%</span>
          <button className="btn btn--ghost btn--icon-sm" onClick={zoomIn} title="Zoom in">
            <ZoomIn size={16} />
          </button>

          <button
            className={`btn btn--ghost btn--icon-sm ${fitMode === 'width' ? 'pdf-tool-active' : ''}`}
            onClick={() => setFitMode('width')}
            title="Fit to width"
          >
            <AlignJustify size={16} />
          </button>
          <button
            className={`btn btn--ghost btn--icon-sm ${fitMode === 'page' ? 'pdf-tool-active' : ''}`}
            onClick={() => setFitMode('page')}
            title="Fit to page"
          >
            <Maximize size={16} />
          </button>

          <div className="pdf-toolbar-divider" />

          {/* View mode */}
          <button
            className={`btn btn--ghost btn--icon-sm ${viewMode === 'single' ? 'pdf-tool-active' : ''}`}
            onClick={() => setViewMode('single')}
            title="Single page view"
          >
            <FileText size={16} />
          </button>
          <button
            className={`btn btn--ghost btn--icon-sm ${viewMode === 'double' ? 'pdf-tool-active' : ''}`}
            onClick={() => setViewMode('double')}
            title="Two page spread"
          >
            <Columns2 size={16} />
          </button>
        </div>

        <div className="pdf-toolbar-right">
          <button className={`btn btn--ghost btn--icon-sm ${showSearch ? 'pdf-tool-active' : ''}`} onClick={() => setShowSearch(!showSearch)} title="Search (Ctrl+F)">
            <Search size={16} />
          </button>
          <button
            className={`btn btn--ghost btn--icon-sm ${showNotesPanel ? 'pdf-tool-active' : ''}`}
            onClick={() => setShowNotesPanel(!showNotesPanel)}
            title="Notes panel"
          >
            <StickyNote size={16} />
            {noteAnnotations.length > 0 && <span className="pdf-notes-badge">{noteAnnotations.length}</span>}
          </button>
        </div>
      </div>

      {/* Search Bar */}
      {showSearch && (
        <div className="pdf-search-bar">
          <Search size={16} />
          <input
            className="pdf-search-input"
            placeholder="Search in document…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            autoFocus
          />
          {searchText && (
            <button className="btn btn--ghost btn--icon-sm" onClick={() => { setSearchText(''); setShowSearch(false); }}>
              <X size={14} />
            </button>
          )}
        </div>
      )}

      <div className="pdf-body">
        {/* Annotation Toolbar (Left sidebar) */}
        <div className="pdf-annotation-toolbar">
          {tools.map(({ tool, icon: Icon, label }) => (
            <button
              key={tool}
              className={`pdf-ann-tool ${activeTool === tool ? 'pdf-ann-tool--active' : ''}`}
              onClick={() => setActiveTool(tool)}
              title={label}
            >
              <Icon size={18} />
            </button>
          ))}

          <div className="pdf-ann-divider" />

          {/* Color picker */}
          <div className="pdf-color-picker-wrap">
            <button
              className="pdf-ann-tool pdf-color-trigger"
              onClick={() => setShowColorPicker(!showColorPicker)}
              title="Color"
            >
              <Palette size={18} />
              <span className="pdf-color-dot" style={{ background: activeColor }} />
            </button>
            {showColorPicker && (
              <div className="pdf-color-picker">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    className={`pdf-color-swatch ${activeColor === c ? 'pdf-color-swatch--active' : ''}`}
                    style={{ background: c }}
                    onClick={() => { setActiveColor(c); setShowColorPicker(false); }}
                  />
                ))}
                <div className="pdf-thickness-picker">
                  {THICKNESSES.map((t) => (
                    <button
                      key={t}
                      className={`pdf-thickness-btn ${activeThickness === t ? 'pdf-thickness-btn--active' : ''}`}
                      onClick={() => setActiveThickness(t)}
                    >
                      <span style={{ width: t * 2, height: t * 2, borderRadius: '50%', background: activeColor }} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="pdf-ann-divider" />

          {/* Undo / Redo */}
          <button className="pdf-ann-tool" onClick={handleUndo} disabled={undoStack.length === 0} title="Undo (Ctrl+Z)">
            <Undo2 size={18} />
          </button>
          <button className="pdf-ann-tool" onClick={handleRedo} disabled={redoStack.length === 0} title="Redo (Ctrl+Shift+Z)">
            <Redo2 size={18} />
          </button>

          <div className="pdf-ann-divider" />

          {/* Save */}
          <button
            className="pdf-ann-tool pdf-save-btn"
            onClick={handleSaveAnnotations}
            disabled={isSaving}
            title="Save annotations (Ctrl+S)"
          >
            {isSaving ? <Loader2 size={18} className="spin-animation" /> : <Save size={18} />}
          </button>
        </div>

        {/* PDF Pages */}
        <div className="pdf-scroll-container" ref={scrollContainerRef}>
          <div className={`pdf-pages ${viewMode === 'double' ? 'pdf-pages--double' : ''}`}>
            {pdfDoc && viewMode === 'single' &&
              Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1).map((pageNum) => (
                <PDFPage
                  key={pageNum}
                  pdfDoc={pdfDoc}
                  pageNumber={pageNum}
                  scale={scale}
                  isVisible={visiblePages.has(pageNum)}
                  searchText={searchText}
                  annotations={annotations.filter((a) => a.page === pageNum)}
                  activeTool={activeTool}
                  activeColor={activeColor}
                  activeThickness={activeThickness}
                  onAddAnnotation={handleAddAnnotation}
                  onRemoveAnnotation={handleRemoveAnnotation}
                />
              ))
            }
            {pdfDoc && viewMode === 'double' &&
              Array.from(
                { length: Math.ceil(pdfDoc.numPages / 2) },
                (_, i) => [i * 2 + 1, i * 2 + 2]
              ).map(([left, right]) => (
                <div className="pdf-page-spread" key={`spread-${left}`}>
                  <PDFPage
                    pdfDoc={pdfDoc}
                    pageNumber={left}
                    scale={scale}
                    isVisible={visiblePages.has(left)}
                    searchText={searchText}
                    annotations={annotations.filter((a) => a.page === left)}
                    activeTool={activeTool}
                    activeColor={activeColor}
                    activeThickness={activeThickness}
                    onAddAnnotation={handleAddAnnotation}
                    onRemoveAnnotation={handleRemoveAnnotation}
                  />
                  {right <= pdfDoc.numPages && (
                    <PDFPage
                      pdfDoc={pdfDoc}
                      pageNumber={right}
                      scale={scale}
                      isVisible={visiblePages.has(right)}
                      searchText={searchText}
                      annotations={annotations.filter((a) => a.page === right)}
                      activeTool={activeTool}
                      activeColor={activeColor}
                      activeThickness={activeThickness}
                      onAddAnnotation={handleAddAnnotation}
                      onRemoveAnnotation={handleRemoveAnnotation}
                    />
                  )}
                </div>
              ))
            }
          </div>
        </div>

        {/* Notes Panel (Right sidebar) */}
        {showNotesPanel && (
          <div className="pdf-notes-panel">
            <div className="pdf-notes-panel-header">
              <h3>Notes & Annotations</h3>
              <button className="btn btn--ghost btn--icon-sm" onClick={() => setShowNotesPanel(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="pdf-notes-panel-body">
              {noteAnnotations.length === 0 ? (
                <p className="pdf-notes-empty">No notes yet. Use the note tool to add notes on any page.</p>
              ) : (
                noteAnnotations.map((ann) => (
                  <div key={ann.tempId} className="pdf-note-item" onClick={() => goToPage(ann.page)}>
                    <div className="pdf-note-page">Page {ann.page}</div>
                    <div className="pdf-note-text">{ann.data.text}</div>
                    <button
                      className="pdf-note-delete"
                      onClick={(e) => { e.stopPropagation(); handleRemoveAnnotation(ann.tempId); }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PDFReaderPage;
