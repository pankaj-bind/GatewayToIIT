import os
import json
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
import tempfile
import time
import io
import logging

from django.conf import settings
from django.db import connection, close_old_connections

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request, AuthorizedSession
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload

from .models import Video

# Path to token.json
TOKEN_PATH = os.path.join(settings.BASE_DIR, 'token.json')
logger = logging.getLogger(__name__)

# =============================================================================
# Video Processing Worker Pool
# =============================================================================
DEFAULT_MAX_WORKERS = max(1, min(4, (os.cpu_count() or 2) // 2))
MAX_WORKERS = int(os.environ.get('VIDEO_PROCESSING_WORKERS', DEFAULT_MAX_WORKERS))
PROCESSING_EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS)
PROCESS_REGISTRY = {}
PROCESS_REGISTRY_LOCK = threading.Lock()


def register_processing(video_id, process, temp_file_path, output_path, cancel_event):
    with PROCESS_REGISTRY_LOCK:
        PROCESS_REGISTRY[video_id] = {
            'process': process,
            'temp_file_path': temp_file_path,
            'output_path': output_path,
            'cancel_event': cancel_event,
        }


def unregister_processing(video_id):
    with PROCESS_REGISTRY_LOCK:
        return PROCESS_REGISTRY.pop(video_id, None)


def cancel_processing(video_id):
    with PROCESS_REGISTRY_LOCK:
        info = PROCESS_REGISTRY.get(video_id)

    if not info:
        return False

    info['cancel_event'].set()
    process = info.get('process')

    if process and process.poll() is None:
        process.terminate()

    return True

class DriveService:
    def __init__(self):
        self.creds = None
        if os.path.exists(TOKEN_PATH):
            self.creds = Credentials.from_authorized_user_file(TOKEN_PATH, ['https://www.googleapis.com/auth/drive'])
        
        if not self.creds or not self.creds.valid:
            if self.creds and self.creds.expired and self.creds.refresh_token:
                self.creds.refresh(Request())
            else:
                raise Exception("Google Drive credentials not valid. Run setup_auth.py first.")
        
        self.service = build('drive', 'v3', credentials=self.creds)

    def get_or_create_folder(self, folder_path):
        """Navigate/create a folder hierarchy and return the final folder ID.
        
        Args:
            folder_path: Slash-separated path (e.g., "Gate/Digital Logic/MyVideo")
        
        Returns:
            Google Drive folder ID of the deepest folder
        """
        parent_folder_id = os.environ.get('GOOGLE_DRIVE_FOLDER_ID')
        if not parent_folder_id:
            raise Exception("GOOGLE_DRIVE_FOLDER_ID not configured")
        
        folder_names = folder_path.split('/')
        current_parent = parent_folder_id
        
        for folder_name in folder_names:
            query = f"name='{folder_name}' and '{current_parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false"
            results = self.service.files().list(q=query, spaces='drive', fields='files(id, name)').execute()
            folders = results.get('files', [])
            
            if folders:
                current_parent = folders[0]['id']
            else:
                folder_metadata = {
                    'name': folder_name,
                    'mimeType': 'application/vnd.google-apps.folder',
                    'parents': [current_parent]
                }
                folder = self.service.files().create(body=folder_metadata, fields='id').execute()
                current_parent = folder.get('id')
        
        return current_parent

    def upload_to_folder(self, file_path, title, parent_folder_id, progress_callback=None, mime_override=None):
        """Upload a file into a specific Drive folder.
        
        Args:
            file_path: Path to the local file
            title: Name for the file in Drive
            parent_folder_id: Drive folder ID to upload into
            progress_callback: Optional callable(float) receiving 0.0-1.0 progress
            mime_override: Optional MIME type (default: video/mp4)
        
        Returns:
            Google Drive file ID
        """
        file_metadata = {
            'name': title,
            'parents': [parent_folder_id]
        }
        
        media = MediaFileUpload(
            file_path,
            mimetype=mime_override or 'video/mp4',
            resumable=True,
            chunksize=10 * 1024 * 1024
        )
        
        request = self.service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id'
        )
        
        response = None
        while response is None:
            upload_status, response = request.next_chunk()
            if upload_status and progress_callback:
                progress_callback(upload_status.progress())
        
        if progress_callback:
            progress_callback(1.0)
        
        return response.get('id')

    def upload_file(self, file_path, title, folder_path=None, progress_callback=None, mime_override=None):
        """Upload file to Google Drive with optimized 10MB chunks for faster upload.
        
        Args:
            file_path: Path to the local file
            title: Name for the file in Drive
            folder_path: Optional category/organization path (e.g., "Work/ProjectA")
            progress_callback: Optional callable(float) receiving 0.0-1.0 progress
            mime_override: Optional MIME type override (default: video/mp4)
        
        Returns:
            Google Drive file ID
        """
        if folder_path:
            parent_folder_id = self.get_or_create_folder(folder_path)
        else:
            parent_folder_id = os.environ.get('GOOGLE_DRIVE_FOLDER_ID')
        
        return self.upload_to_folder(file_path, title, parent_folder_id, progress_callback, mime_override)

    def get_file_stream(self, file_id):
        """Legacy method - kept for backward compatibility. Loads entire file into memory."""
        request = self.service.files().get_media(fileId=file_id)
        file_io = io.BytesIO()
        downloader = MediaIoBaseDownload(file_io, request)
        done = False
        while done is False:
            status, done = downloader.next_chunk()
        
        file_io.seek(0)
        return file_io

    def get_file_metadata(self, file_id):
        """Return size (bytes) and mimeType for a Drive file."""
        meta = self.service.files().get(
            fileId=file_id, fields='size,mimeType'
        ).execute()
        return {
            'size': int(meta.get('size', 0)),
            'mimeType': meta.get('mimeType', 'video/mp4'),
        }

    def get_file_range_iterator(self, file_id, start=0, end=None):
        """Yield chunks for a byte-range of a Drive file.

        Args:
            file_id: Google Drive file ID
            start: First byte position (inclusive)
            end: Last byte position (inclusive). None = to EOF.

        Yields:
            bytes chunks (~1 MB each)
        """
        if self.creds.expired and self.creds.refresh_token:
            self.creds.refresh(Request())

        session = AuthorizedSession(self.creds)
        url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"

        headers = {}
        if end is not None:
            headers['Range'] = f'bytes={start}-{end}'
        elif start > 0:
            headers['Range'] = f'bytes={start}-'

        response = session.get(url, stream=True, headers=headers)
        response.raise_for_status()

        for chunk in response.iter_content(chunk_size=2 * 1024 * 1024):
            if chunk:
                yield chunk

    def get_file_iterator(self, file_id):
        """Yields chunks of data from Google Drive without loading file into memory.
        
        This is the recommended method for streaming large files as it:
        - Doesn't load the entire file into memory
        - Streams data progressively to the client
        - Handles large files (100MB+) without timeout issues
        """
        # Refresh auth if needed
        if self.creds.expired and self.creds.refresh_token:
            self.creds.refresh(Request())
        
        # Create authorized session for streaming
        session = AuthorizedSession(self.creds)
        url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
        
        # stream=True prevents loading entire response into memory
        response = session.get(url, stream=True)
        response.raise_for_status()
        
        # Yield 2MB chunks to the caller
        for chunk in response.iter_content(chunk_size=2 * 1024 * 1024):
            if chunk:
                yield chunk

    def download_file_to_temp(self, file_id, suffix='.mp4'):
        """Download a file from Google Drive to a local temp file.
        
        Args:
            file_id: Google Drive file ID
            suffix: File extension for the temp file
        
        Returns:
            Path to the downloaded temp file
        """
        request = self.service.files().get_media(fileId=file_id)
        temp_file = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        downloader = MediaIoBaseDownload(temp_file, request, chunksize=10 * 1024 * 1024)
        
        done = False
        while not done:
            status, done = downloader.next_chunk()
        
        temp_file.close()
        return temp_file.name

    def move_file_to_folder(self, file_id, new_parent_id):
        """Move a file into a different folder on Google Drive."""
        try:
            # Get current parents
            file_info = self.service.files().get(fileId=file_id, fields='parents').execute()
            old_parents = ','.join(file_info.get('parents', []))
            
            self.service.files().update(
                fileId=file_id,
                addParents=new_parent_id,
                removeParents=old_parents,
                fields='id'
            ).execute()
        except Exception as e:
            logger.error(f"Error moving file {file_id}: {e}")
            raise

    def file_exists(self, file_id):
        """Check if a file or folder still exists (not trashed) on Google Drive."""
        try:
            f = self.service.files().get(fileId=file_id, fields='id,trashed').execute()
            return not f.get('trashed', False)
        except Exception:
            return False

    def _list_subfolders(self, parent_id):
        """List immediate subfolders of a given Drive folder ID."""
        subfolders = []
        page_token = None
        while True:
            query = (
                f"'{parent_id}' in parents "
                f"and mimeType='application/vnd.google-apps.folder' "
                f"and trashed=false"
            )
            resp = self.service.files().list(
                q=query,
                spaces='drive',
                fields='nextPageToken, files(id, name)',
                pageSize=1000,
                pageToken=page_token,
            ).execute()
            subfolders.extend(resp.get('files', []))
            page_token = resp.get('nextPageToken')
            if not page_token:
                break
        return subfolders

    def walk_category_tree(self, category_name):
        """Discover the org/chapter hierarchy for a category on Drive.

        Looks for {GOOGLE_DRIVE_FOLDER_ID}/{category_name}/ and walks two
        levels down (organizations, then chapters). Returns None if the
        category folder itself is not found on Drive.
        """
        parent_folder_id = os.environ.get('GOOGLE_DRIVE_FOLDER_ID')
        if not parent_folder_id:
            return None

        category_id = self.folder_exists_in_path(category_name)
        if not category_id:
            return None

        organizations = []
        for org in self._list_subfolders(category_id):
            chapters = [
                {'name': ch['name'], 'folder_id': ch['id']}
                for ch in self._list_subfolders(org['id'])
            ]
            organizations.append({
                'name': org['name'],
                'folder_id': org['id'],
                'chapters': chapters,
            })

        return {
            'drive_folder_id': category_id,
            'organizations': organizations,
        }

    def folder_exists_in_path(self, folder_path):
        """Check whether a full folder path still exists on Drive.

        Returns the folder ID if every segment exists, or None.
        """
        parent_folder_id = os.environ.get('GOOGLE_DRIVE_FOLDER_ID')
        if not parent_folder_id:
            return None

        folder_names = folder_path.split('/')
        current_parent = parent_folder_id

        for folder_name in folder_names:
            query = (
                f"name='{folder_name}' and '{current_parent}' in parents "
                f"and mimeType='application/vnd.google-apps.folder' and trashed=false"
            )
            results = self.service.files().list(
                q=query, spaces='drive', fields='files(id)'
            ).execute()
            folders = results.get('files', [])
            if not folders:
                return None
            current_parent = folders[0]['id']

        return current_parent

    def rename_file(self, file_id, new_name):
        """Rename a file on Google Drive."""
        try:
            self.service.files().update(
                fileId=file_id,
                body={'name': new_name},
                fields='id,name'
            ).execute()
        except Exception as e:
            logger.error(f"Error renaming file {file_id}: {e}")
            raise

    def rename_folder(self, folder_id, new_name):
        """Rename a folder on Google Drive."""
        try:
            self.service.files().update(
                fileId=folder_id,
                body={'name': new_name},
                fields='id,name'
            ).execute()
        except Exception as e:
            logger.error(f"Error renaming folder {folder_id}: {e}")
            raise

    def delete_file(self, file_id):
        try:
            self.service.files().delete(fileId=file_id).execute()
        except Exception as e:
            print(f"Error deleting file from Drive: {e}")

    def delete_folder(self, folder_id):
        """Delete an entire folder and all its contents from Google Drive."""
        try:
            self.service.files().delete(fileId=folder_id).execute()
        except Exception as e:
            logger.error(f"Error deleting folder {folder_id}: {e}")

    def list_folder_contents(self, folder_id):
        """List all files (non-folder) in a Drive folder."""
        try:
            query = f"'{folder_id}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'"
            results = self.service.files().list(
                q=query,
                spaces='drive',
                fields='files(id, name, size, mimeType)',
            ).execute()
            return results.get('files', [])
        except Exception as e:
            logger.error(f"Error listing folder contents: {e}")
            return []

    def list_folder_files(self, folder_path):
        """List all video files in a specific Google Drive folder path.
        
        Supports both:
        - Loose video files directly in the org folder (legacy/manual uploads)
        - Video subfolders (new structure: VideoName/video.mp4 + thumbnail + preview)
        
        Returns:
            List of dicts: {id, name, size, mimeType, createdTime, drive_folder_id?,
                            thumbnail_id?, preview_id?}
        """
        try:
            parent_folder_id = os.environ.get('GOOGLE_DRIVE_FOLDER_ID')
            
            if not parent_folder_id:
                raise Exception("GOOGLE_DRIVE_FOLDER_ID not configured")
            
            # Navigate to the target folder
            if folder_path:
                folder_names = folder_path.split('/')
                current_parent = parent_folder_id
                
                for folder_name in folder_names:
                    query = f"name='{folder_name}' and '{current_parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false"
                    results = self.service.files().list(q=query, spaces='drive', fields='files(id, name)').execute()
                    folders = results.get('files', [])
                    
                    if not folders:
                        return []
                    
                    current_parent = folders[0]['id']
                
                parent_folder_id = current_parent
            
            all_videos = []
            
            # 1) Loose video files directly in the org folder
            query = f"'{parent_folder_id}' in parents and mimeType contains 'video/' and trashed=false"
            results = self.service.files().list(
                q=query,
                spaces='drive',
                fields='files(id, name, size, mimeType, createdTime, videoMediaMetadata)',
                orderBy='createdTime desc'
            ).execute()
            all_videos.extend(results.get('files', []))
            
            # 2) Subfolders (new structure) — look inside each subfolder for video files
            subfolder_query = f"'{parent_folder_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false"
            subfolder_results = self.service.files().list(
                q=subfolder_query,
                spaces='drive',
                fields='files(id, name, createdTime)',
            ).execute()
            
            for subfolder in subfolder_results.get('files', []):
                sf_id = subfolder['id']
                # List files inside the subfolder
                inner_query = f"'{sf_id}' in parents and trashed=false"
                inner_results = self.service.files().list(
                    q=inner_query,
                    spaces='drive',
                    fields='files(id, name, size, mimeType, videoMediaMetadata)',
                ).execute()
                inner_files = inner_results.get('files', [])
                
                video_file = None
                thumbnail_id = None
                preview_id = None
                
                for f in inner_files:
                    mime = f.get('mimeType', '')
                    name = f.get('name', '')
                    if name == 'thumbnail.jpg':
                        thumbnail_id = f['id']
                    elif name == 'preview.mp4':
                        preview_id = f['id']
                    elif mime.startswith('video/'):
                        video_file = f
                
                if video_file:
                    video_file['drive_folder_id'] = sf_id
                    video_file['thumbnail_id'] = thumbnail_id
                    video_file['preview_id'] = preview_id
                    video_file['createdTime'] = subfolder.get('createdTime')
                    all_videos.append(video_file)
            
            return all_videos
            
        except Exception as e:
            print(f"Error listing folder files: {e}")
            return []

    def list_folder_pdfs(self, folder_path):
        """List all PDF files in a specific Google Drive folder path.
        
        Supports both:
        - Loose PDF files directly in the folder
        - PDF subfolders (structure: PdfName/file.pdf)
        
        Returns:
            List of dicts: {id, name, size, mimeType, createdTime, drive_folder_id?}
        """
        try:
            parent_folder_id = os.environ.get('GOOGLE_DRIVE_FOLDER_ID')
            if not parent_folder_id:
                raise Exception("GOOGLE_DRIVE_FOLDER_ID not configured")

            # Navigate to the target folder
            if folder_path:
                folder_names = folder_path.split('/')
                current_parent = parent_folder_id
                for folder_name in folder_names:
                    query = (
                        f"name='{folder_name}' and '{current_parent}' in parents "
                        f"and mimeType='application/vnd.google-apps.folder' and trashed=false"
                    )
                    results = self.service.files().list(
                        q=query, spaces='drive', fields='files(id, name)'
                    ).execute()
                    folders = results.get('files', [])
                    if not folders:
                        return []
                    current_parent = folders[0]['id']
                parent_folder_id = current_parent

            all_pdfs = []

            # 1) Loose PDF files directly in the folder
            query = (
                f"'{parent_folder_id}' in parents "
                f"and mimeType='application/pdf' and trashed=false"
            )
            results = self.service.files().list(
                q=query,
                spaces='drive',
                fields='files(id, name, size, mimeType, createdTime)',
                orderBy='createdTime desc',
            ).execute()
            all_pdfs.extend(results.get('files', []))

            # 2) Subfolders — look inside each subfolder for PDF files
            subfolder_query = (
                f"'{parent_folder_id}' in parents "
                f"and mimeType='application/vnd.google-apps.folder' and trashed=false"
            )
            subfolder_results = self.service.files().list(
                q=subfolder_query,
                spaces='drive',
                fields='files(id, name, createdTime)',
            ).execute()

            for subfolder in subfolder_results.get('files', []):
                sf_id = subfolder['id']
                inner_query = (
                    f"'{sf_id}' in parents "
                    f"and mimeType='application/pdf' and trashed=false"
                )
                inner_results = self.service.files().list(
                    q=inner_query,
                    spaces='drive',
                    fields='files(id, name, size, mimeType)',
                ).execute()
                inner_files = inner_results.get('files', [])

                for pdf_file in inner_files:
                    pdf_file['drive_folder_id'] = sf_id
                    pdf_file['createdTime'] = subfolder.get('createdTime')
                    all_pdfs.append(pdf_file)

            return all_pdfs

        except Exception as e:
            logger.error(f"Error listing folder PDFs: {e}")
            return []

class VideoProcessor:
    def __init__(self, input_path, output_path):
        self.input_path = input_path
        self.output_path = output_path

    def has_audio(self):
        """Checks if the video has an audio stream using ffprobe."""
        try:
            cmd = [
                'ffprobe', 
                '-v', 'error', 
                '-select_streams', 'a', 
                '-show_entries', 'stream=codec_type', 
                '-of', 'csv=p=0', 
                self.input_path
            ]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            return len(result.stdout.strip()) > 0
        except Exception as e:
            print(f"Error checking audio: {e}")
            return False

    def get_duration(self):
        """Get video duration in seconds using ffprobe."""
        try:
            cmd = [
                'ffprobe',
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'csv=p=0',
                self.input_path
            ]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            duration_str = result.stdout.strip()
            if duration_str:
                return float(duration_str)
        except Exception as e:
            logger.warning(f"Error getting duration: {e}")
        return None

    def generate_thumbnail(self, output_thumbnail_path, timestamp=1):
        """Extract a single frame as a JPEG thumbnail.
        
        Args:
            output_thumbnail_path: Path to save the thumbnail image
            timestamp: Seconds into the video to capture (default 1s)
        """
        try:
            duration = self.get_duration()
            # If video is shorter than the timestamp, capture at 0s
            if duration and timestamp >= duration:
                timestamp = 0

            cmd = [
                'ffmpeg', '-y',
                '-ss', str(timestamp),
                '-i', self.input_path,
                '-vframes', '1',
                '-vf', 'scale=640:-2',
                '-q:v', '2',  # High quality JPEG
                output_thumbnail_path
            ]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            if result.returncode == 0 and os.path.exists(output_thumbnail_path):
                return True
        except Exception as e:
            logger.warning(f"Thumbnail generation failed: {e}")
        return False

    def generate_preview(self, output_preview_path, start=1, clip_duration=6):
        """Generate a short muted preview clip for hover playback.
        
        Args:
            output_preview_path: Path to save the preview video
            start: Start time in seconds (default 1s)
            clip_duration: Duration of the preview clip in seconds (default 6s)
        """
        try:
            duration = self.get_duration()
            # Adjust start/duration for short videos
            if duration:
                if start >= duration:
                    start = 0
                if start + clip_duration > duration:
                    clip_duration = max(1, duration - start)

            cmd = [
                'ffmpeg', '-y',
                '-ss', str(start),
                '-i', self.input_path,
                '-t', str(clip_duration),
                '-vf', 'scale=480:-2',
                '-an',  # No audio for preview
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '28',
                '-movflags', '+faststart',
                '-pix_fmt', 'yuv420p',
                output_preview_path
            ]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            if result.returncode == 0 and os.path.exists(output_preview_path):
                return True
        except Exception as e:
            logger.warning(f"Preview generation failed: {e}")
        return False

    def process_video(self):
        """Speed up video 2x with quality-preserving encoding settings.
        
        Performance Optimizations (no quality compromise):
        - veryfast preset: Faster encode without reducing visual quality
        - CRF 23: High quality (lower = better). 23 is visually near‑transparent
        - threads 0: Uses all available CPU cores
        - faststart: Moves moov atom to beginning for instant web playback
        - AAC audio: Efficient codec for web compatibility
        """
        has_audio = self.has_audio()
        
        # Base command with performance optimizations (quality-preserving)
        cmd = [
            'ffmpeg',
            '-y',  # Overwrite output
            '-i', self.input_path,
            '-threads', '0',  # Use all CPU cores
            '-preset', 'veryfast',  # Faster encode, quality preserved by CRF
            '-crf', '23',  # High quality (18=visually lossless, 23=high)
        ]

        if has_audio:
            # Filter: Speed up Video (setpts) AND Audio (atempo)
            filter_complex = "[0:v]setpts=0.5*PTS[v];[0:a]atempo=2.0[a]"
            cmd.extend(['-filter_complex', filter_complex])
            cmd.extend(['-map', '[v]', '-map', '[a]'])
            # Re-encode audio with efficient AAC codec
            cmd.extend(['-c:a', 'aac', '-b:a', '128k'])
        else:
            # Filter: Speed up Video only
            filter_complex = "[0:v]setpts=0.5*PTS[v]"
            cmd.extend(['-filter_complex', filter_complex])
            cmd.extend(['-map', '[v]'])
        
        # Web optimization - move metadata to front for instant playback
        cmd.extend(['-movflags', '+faststart'])
        
        # Output file
        cmd.append(self.output_path)
        
        logger.info(f"FFmpeg command: {' '.join(cmd)}")
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return process

def _update_progress(video_id, progress):
    """Safely update video progress from background thread."""
    try:
        close_old_connections()
        Video.objects.filter(id=video_id).update(progress=min(progress, 100))
    except Exception:
        pass  # Non-critical — don't crash processing over a progress update


def process_video_background(video_id, temp_file_path, original_filename, folder_path=None):
    close_old_connections()
    
    thumbnail_path = None
    preview_path = None
    
    try:
        video = Video.objects.get(id=video_id)
        video.status = 'PROCESSING'
        video.progress = 5
        video.save()

        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as output_temp:
            output_path = output_temp.name

        processor = VideoProcessor(temp_file_path, output_path)
        cancel_event = threading.Event()
        
        # ── Get duration from the original file BEFORE processing ──
        _update_progress(video_id, 7)
        original_duration = processor.get_duration()
        
        # ── Generate thumbnail from original file (at 1 second) ──
        _update_progress(video_id, 8)
        temp_dir = tempfile.gettempdir()
        thumbnail_path = os.path.join(temp_dir, f"thumb_{video_id}_{int(time.time())}.jpg")
        thumbnail_ok = processor.generate_thumbnail(thumbnail_path)
        
        # ── Generate preview clip from original file (5 second clip) ──
        _update_progress(video_id, 9)
        preview_path = os.path.join(temp_dir, f"preview_{video_id}_{int(time.time())}.mp4")
        preview_ok = processor.generate_preview(preview_path, clip_duration=5)

        # ── FFmpeg 2x speed processing ──
        process = processor.process_video()

        register_processing(video_id, process, temp_file_path, output_path, cancel_event)

        # FFmpeg phase: 10% → 40%
        _update_progress(video_id, 10)
        stdout, stderr = process.communicate()
        _update_progress(video_id, 40)

        if cancel_event.is_set():
            Video.objects.filter(id=video_id).update(
                status='CANCELED',
                progress=0,
                error_message='Processing canceled by user.'
            )
            return

        if process.returncode != 0:
            error_log = stderr.decode('utf-8')
            raise Exception(f"FFmpeg failed: {error_log}")

        # ── Get processed video duration (should be original / 2) ──
        processed_duration = None
        if original_duration:
            processed_duration = original_duration / 2.0  # 2x speed
        else:
            processed_processor = VideoProcessor(output_path, output_path)
            processed_duration = processed_processor.get_duration()

        # ── Create video folder on Drive & upload all assets ──
        drive_service = DriveService()
        
        # Build video folder name from original filename (without extension)
        video_folder_name = os.path.splitext(original_filename)[0]
        if folder_path:
            full_folder_path = f"{folder_path}/{video_folder_name}"
        else:
            full_folder_path = video_folder_name
        
        video_folder_id = drive_service.get_or_create_folder(full_folder_path)
        _update_progress(video_id, 42)
        
        # Upload processed video into the folder
        def on_drive_progress(frac):
            pct = 42 + int(frac * 48)  # 42-90%
            _update_progress(video_id, pct)
        
        file_id = drive_service.upload_to_folder(
            output_path, f"Processed_{original_filename}", video_folder_id,
            progress_callback=on_drive_progress
        )
        _update_progress(video_id, 92)
        
        # Upload thumbnail to Drive folder
        thumbnail_drive_id = None
        if thumbnail_ok and os.path.exists(thumbnail_path):
            thumbnail_drive_id = drive_service.upload_to_folder(
                thumbnail_path, 'thumbnail.jpg', video_folder_id,
                mime_override='image/jpeg'
            )
        _update_progress(video_id, 95)
        
        # Upload preview to Drive folder
        preview_drive_id = None
        if preview_ok and os.path.exists(preview_path):
            preview_drive_id = drive_service.upload_to_folder(
                preview_path, 'preview.mp4', video_folder_id,
                mime_override='video/mp4'
            )
        _update_progress(video_id, 98)

        # ── Save everything to DB ──
        close_old_connections()
        video = Video.objects.get(id=video_id)
        video.file_id = file_id
        video.drive_folder_id = video_folder_id
        video.status = 'COMPLETED'
        video.progress = 100
        if processed_duration:
            video.duration = processed_duration
        if thumbnail_drive_id:
            video.thumbnail = thumbnail_drive_id
        if preview_drive_id:
            video.preview = preview_drive_id
        video.save()

    except Exception as e:
        logger.error(f"Background Processing Error: {e}")
        try:
            close_old_connections()
            video = Video.objects.get(id=video_id)
            video.status = 'FAILED'
            video.error_message = str(e)
            video.save()
        except Exception as db_e:
             print(f"Failed to save error state: {db_e}")
    finally:
        # Cleanup ALL temp files
        for path in [temp_file_path, thumbnail_path, preview_path]:
            if path and os.path.exists(path):
                try:
                    os.unlink(path)
                except Exception:
                    pass
        if 'output_path' in locals() and os.path.exists(output_path):
            try:
                os.unlink(output_path)
            except Exception:
                pass
        unregister_processing(video_id)
        close_old_connections()

def start_background_processing(video_id, temp_file_path, original_filename, folder_path=None):
    """Submit processing to the shared worker pool for parallel execution."""
    PROCESSING_EXECUTOR.submit(
        process_video_background,
        video_id,
        temp_file_path,
        original_filename,
        folder_path
    )


def generate_sync_metadata(video_id):
    """Download video from Drive, extract duration, generate thumbnail & preview.
    
    For synced videos: downloads temporarily, generates assets,
    uploads thumbnail+preview to Drive (creating a video subfolder if needed),
    then cleans up all local temp files.
    """
    close_old_connections()
    temp_path = None
    thumbnail_path = None
    preview_path = None
    
    try:
        video = Video.objects.get(id=video_id)
        
        if not video.file_id:
            logger.warning(f"Video {video_id} has no file_id, skipping metadata generation")
            return
        
        logger.info(f"Generating metadata for synced video: {video.title} (id={video_id})")
        
        drive_service = DriveService()
        
        # Download from Drive to temp file
        temp_path = drive_service.download_file_to_temp(video.file_id)
        
        processor = VideoProcessor(temp_path, temp_path)
        
        # Extract duration
        duration = processor.get_duration()
        
        # Generate thumbnail locally
        temp_dir = tempfile.gettempdir()
        thumbnail_path = os.path.join(temp_dir, f"thumb_{video_id}_{int(time.time())}.jpg")
        thumbnail_ok = processor.generate_thumbnail(thumbnail_path)
        
        # Generate preview locally (5 second clip)
        preview_path = os.path.join(temp_dir, f"preview_{video_id}_{int(time.time())}.mp4")
        preview_ok = processor.generate_preview(preview_path, clip_duration=5)
        
        # Ensure a video folder exists on Drive
        video_folder_id = video.drive_folder_id
        
        if not video_folder_id:
            # Create a subfolder for this video and move the video file into it
            video_folder_name = os.path.splitext(video.title)[0]
            if video.folder_path:
                full_folder_path = f"{video.folder_path}/{video_folder_name}"
            else:
                full_folder_path = video_folder_name
            
            video_folder_id = drive_service.get_or_create_folder(full_folder_path)
            
            # Move the video file into the new subfolder
            try:
                drive_service.move_file_to_folder(video.file_id, video_folder_id)
            except Exception as move_err:
                logger.warning(f"Could not move video {video_id} to subfolder: {move_err}")
        
        # Upload thumbnail to Drive
        thumbnail_drive_id = None
        if thumbnail_ok and os.path.exists(thumbnail_path):
            thumbnail_drive_id = drive_service.upload_to_folder(
                thumbnail_path, 'thumbnail.jpg', video_folder_id,
                mime_override='image/jpeg'
            )
        
        # Upload preview to Drive
        preview_drive_id = None
        if preview_ok and os.path.exists(preview_path):
            preview_drive_id = drive_service.upload_to_folder(
                preview_path, 'preview.mp4', video_folder_id,
                mime_override='video/mp4'
            )
        
        # Save to DB
        close_old_connections()
        video = Video.objects.get(id=video_id)
        video.drive_folder_id = video_folder_id
        if duration:
            video.duration = duration
        if thumbnail_drive_id:
            video.thumbnail = thumbnail_drive_id
        if preview_drive_id:
            video.preview = preview_drive_id
        video.save()
        
        logger.info(f"Metadata generated for video {video_id}: duration={duration}, thumb={bool(thumbnail_drive_id)}, preview={bool(preview_drive_id)}")
    
    except Exception as e:
        logger.error(f"Metadata generation error for video {video_id}: {e}")
    finally:
        for path in [temp_path, thumbnail_path, preview_path]:
            if path and os.path.exists(path):
                try:
                    os.unlink(path)
                except Exception:
                    pass
        close_old_connections()


def start_sync_metadata(video_id):
    """Submit metadata generation to the shared worker pool."""
    PROCESSING_EXECUTOR.submit(generate_sync_metadata, video_id)