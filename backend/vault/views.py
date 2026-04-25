import logging
from django.db.models import Count
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.views import APIView
from .models import Category, Organization, Chapter, ChapterNote
from .serializers import (
    CategorySerializer, 
    CategoryCreateSerializer,
    OrganizationSerializer,
    OrganizationCreateSerializer,
    ChapterSerializer,
    ChapterCreateSerializer,
    ChapterNoteSerializer,
)

logger = logging.getLogger(__name__)


class CategoryViewSet(viewsets.ModelViewSet):
    """ViewSet for Category CRUD operations"""
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        from django.db.models import Prefetch
        return Category.objects.filter(user=self.request.user).prefetch_related(
            Prefetch(
                'organizations',
                queryset=Organization.objects.annotate(
                    video_count=Count('videos', distinct=True),
                    chapter_count=Count('chapters', distinct=True),
                    pdf_count=Count('pdfs', distinct=True),
                )
            )
        )

    def get_serializer_class(self):
        if self.action in ['create', 'update', 'partial_update']:
            return CategoryCreateSerializer
        return CategorySerializer

    def perform_create(self, serializer):
        serializer.save()

    def create(self, request, *args, **kwargs):
        """Create a Category, then auto-import org/chapter/content tree
        from Drive if {ROOT}/{CategoryName}/ exists."""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        category = serializer.instance

        imported = {'orgs': 0, 'chapters': 0, 'videos': 0, 'pdfs': 0, 'errors': []}

        try:
            from videos.services import DriveService
            drive_service = DriveService()
            tree = drive_service.walk_category_tree(category.name)
        except Exception as e:
            logger.warning(f'Drive walk skipped for category {category.name}: {e}')
            tree = None

        if tree:
            for org_entry in tree.get('organizations', []):
                try:
                    organization, _ = Organization.objects.get_or_create(
                        category=category,
                        name=org_entry['name'],
                    )
                    imported['orgs'] += 1
                except Exception as e:
                    imported['errors'].append(f"org {org_entry.get('name')}: {e}")
                    continue

                for ch_entry in org_entry.get('chapters', []):
                    try:
                        chapter, _ = Chapter.objects.get_or_create(
                            organization=organization,
                            name=ch_entry['name'],
                        )
                        imported['chapters'] += 1

                        folder_path = f"{category.name}/{organization.name}/{chapter.name}"
                        result = sync_chapter(
                            user=request.user,
                            organization=organization,
                            chapter=chapter,
                            folder_path=folder_path,
                            drive_service=drive_service,
                        )
                        imported['videos'] += result['synced']
                        imported['pdfs'] += result['pdf_synced']
                    except Exception as e:
                        imported['errors'].append(f"chapter {ch_entry.get('name')}: {e}")
                        logger.error(f'Error importing chapter: {e}', exc_info=True)

        out = CategorySerializer(category, context={'request': request}).data
        out['imported'] = imported
        headers = self.get_success_headers(serializer.data)
        return Response(out, status=status.HTTP_201_CREATED, headers=headers)

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.user != request.user:
            return Response(
                {"error": "You don't have permission to delete this category."},
                status=status.HTTP_403_FORBIDDEN
            )
        return super().destroy(request, *args, **kwargs)


class OrganizationViewSet(viewsets.ModelViewSet):
    """ViewSet for Organization CRUD operations"""
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]
    
    def get_queryset(self):
        return Organization.objects.filter(
            category__user=self.request.user
        ).annotate(
            video_count=Count('videos', distinct=True),
            chapter_count=Count('chapters', distinct=True),
            pdf_count=Count('pdfs', distinct=True),
        )
    
    def get_serializer_class(self):
        if self.action in ['create', 'update', 'partial_update']:
            return OrganizationCreateSerializer
        return OrganizationSerializer
    
    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.category.user != request.user:
            return Response(
                {"error": "You don't have permission to delete this organization."},
                status=status.HTTP_403_FORBIDDEN
            )
        return super().destroy(request, *args, **kwargs)
    
    @action(detail=True, methods=['post'])
    def upload_logo(self, request, pk=None):
        """Upload or update organization logo"""
        organization = self.get_object()
        
        if organization.category.user != request.user:
            return Response(
                {"error": "You don't have permission to modify this organization."},
                status=status.HTTP_403_FORBIDDEN
            )
        
        if 'logo' not in request.FILES:
            return Response(
                {"error": "No logo file provided."},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Delete old logo if exists
        if organization.logo:
            organization.logo.delete()
        
        organization.logo = request.FILES['logo']
        organization.save()
        
        serializer = self.get_serializer(organization, context={'request': request})
        return Response(serializer.data)
    
    @action(detail=True, methods=['delete'])
    def remove_logo(self, request, pk=None):
        """Remove organization logo"""
        organization = self.get_object()
        
        if organization.category.user != request.user:
            return Response(
                {"error": "You don't have permission to modify this organization."},
                status=status.HTTP_403_FORBIDDEN
            )
        
        if organization.logo:
            organization.logo.delete()
            organization.save()
        
        serializer = self.get_serializer(organization, context={'request': request})
        return Response(serializer.data)


class ChapterViewSet(viewsets.ModelViewSet):
    """ViewSet for Chapter CRUD operations"""
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = Chapter.objects.filter(
            organization__category__user=self.request.user
        ).select_related('note').annotate(
            video_count=Count('videos'),
            pdf_count=Count('pdfs', distinct=True),
        )
        # Optionally filter by organization
        org_id = self.request.query_params.get('organization')
        if org_id:
            qs = qs.filter(organization_id=org_id)
        return qs

    def get_serializer_class(self):
        if self.action in ['create', 'update', 'partial_update']:
            return ChapterCreateSerializer
        return ChapterSerializer

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.organization.category.user != request.user:
            return Response(
                {"error": "You don't have permission to delete this chapter."},
                status=status.HTTP_403_FORBIDDEN
            )
        return super().destroy(request, *args, **kwargs)

    @action(detail=True, methods=['get', 'put', 'patch'], url_path='note')
    def note(self, request, pk=None):
        """Get or update the note for a specific chapter"""
        chapter = self.get_object()

        if request.method == 'GET':
            note, _ = ChapterNote.objects.get_or_create(chapter=chapter)
            serializer = ChapterNoteSerializer(note)
            return Response(serializer.data)

        # PUT / PATCH
        note, _ = ChapterNote.objects.get_or_create(chapter=chapter)
        serializer = ChapterNoteSerializer(note, data=request.data, partial=request.method == 'PATCH')
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)


class SyncAllChaptersView(APIView):
    """Sync all chapters for the current user with Google Drive"""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        try:
            from videos.models import Video, PDFDocument
            from videos.services import DriveService

            user = request.user
            drive_service = DriveService()

            # Get all chapters for this user
            chapters = Chapter.objects.filter(
                organization__category__user=user
            ).select_related('organization', 'organization__category')

            total_synced = 0
            total_deleted = 0
            total_pdf_synced = 0
            total_pdf_deleted = 0
            total_chapters = chapters.count()
            errors = []

            for chapter in chapters:
                organization = chapter.organization
                category = organization.category
                folder_path = f"{category.name}/{organization.name}/{chapter.name}"

                try:
                    result = sync_chapter(
                        user=user,
                        organization=organization,
                        chapter=chapter,
                        folder_path=folder_path,
                        drive_service=drive_service
                    )

                    total_synced += result['synced']
                    total_deleted += result['deleted']
                    total_pdf_synced += result['pdf_synced']
                    total_pdf_deleted += result['pdf_deleted']

                except Exception as e:
                    error_msg = f"{folder_path}: {str(e)}"
                    errors.append(error_msg)
                    logger.error(f'Error syncing chapter {chapter.id}: {e}', exc_info=True)

            return Response({
                'message': 'Sync completed',
                'chapters_processed': total_chapters,
                'videos_synced': total_synced,
                'videos_deleted': total_deleted,
                'pdfs_synced': total_pdf_synced,
                'pdfs_deleted': total_pdf_deleted,
                'errors': errors,
            }, status=status.HTTP_200_OK)

        except Exception as e:
            logger.error(f'Sync all chapters error: {e}', exc_info=True)
            return Response(
                {'error': f'Sync failed: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

def sync_chapter(user, organization, chapter, folder_path, drive_service):
    """Sync a single chapter with Google Drive.

    Module-level so it can be shared between SyncAllChaptersView and
    CategoryViewSet's auto-import-on-create flow.
    """
    from videos.models import Video, PDFDocument
    from videos.services import start_sync_metadata

    synced = 0
    deleted = 0
    pdf_synced = 0
    pdf_deleted = 0

    drive_folder_id = drive_service.folder_exists_in_path(folder_path)

    if drive_folder_id is None:
        purge_filter = {
            'organization': organization,
            'chapter': chapter,
            'user': user,
        }

        deleted_qs = Video.objects.filter(**purge_filter)
        deleted = deleted_qs.count()
        deleted_qs.delete()

        deleted_pdf_qs = PDFDocument.objects.filter(**purge_filter)
        pdf_deleted = deleted_pdf_qs.count()
        deleted_pdf_qs.delete()

        return {
            'synced': 0,
            'deleted': deleted,
            'pdf_synced': 0,
            'pdf_deleted': pdf_deleted,
        }

    drive_files = drive_service.list_folder_files(folder_path)
    drive_file_ids = {f.get('id') for f in drive_files if f.get('id')}
    drive_subfolder_ids = {
        f.get('drive_folder_id') for f in drive_files if f.get('drive_folder_id')
    }

    existing_filter = {
        'organization': organization,
        'chapter': chapter,
        'user': user,
        'file_id__isnull': False,
    }

    db_videos = Video.objects.filter(**existing_filter)

    for video in db_videos:
        still_on_drive = False

        if video.file_id and video.file_id in drive_file_ids:
            still_on_drive = True
        elif video.drive_folder_id and video.drive_folder_id in drive_subfolder_ids:
            still_on_drive = True

        if not still_on_drive:
            if video.drive_folder_id:
                still_on_drive = drive_service.file_exists(video.drive_folder_id)
            elif video.file_id:
                still_on_drive = drive_service.file_exists(video.file_id)

        if not still_on_drive:
            video.delete()
            deleted += 1

    remaining_file_ids = set(
        Video.objects.filter(**existing_filter).values_list('file_id', flat=True)
    )

    new_video_ids = []
    for drive_file in drive_files:
        file_id = drive_file.get('id')
        if file_id in remaining_file_ids:
            continue

        drive_duration = None
        vmm = drive_file.get('videoMediaMetadata')
        if vmm and vmm.get('durationMillis'):
            try:
                drive_duration = int(vmm['durationMillis']) / 1000.0
            except (ValueError, TypeError):
                pass

        video = Video.objects.create(
            user=user,
            title=drive_file.get('name', 'Untitled'),
            file_id=file_id,
            status='COMPLETED',
            organization=organization,
            chapter=chapter,
            category=organization.category,
            folder_path=folder_path,
            file_size=int(drive_file.get('size', 0)),
            mime_type=drive_file.get('mimeType', ''),
            drive_folder_id=drive_file.get('drive_folder_id'),
            thumbnail=drive_file.get('thumbnail_id'),
            preview=drive_file.get('preview_id'),
            duration=drive_duration,
        )
        new_video_ids.append(video.id)
        synced += 1

    for vid_id in new_video_ids:
        try:
            start_sync_metadata(vid_id)
        except Exception:
            pass

    try:
        drive_pdfs = drive_service.list_folder_pdfs(folder_path)
        drive_pdf_file_ids = {f.get('id') for f in drive_pdfs if f.get('id')}
        drive_pdf_subfolder_ids = {
            f.get('drive_folder_id') for f in drive_pdfs if f.get('drive_folder_id')
        }

        pdf_filter = {
            'organization': organization,
            'chapter': chapter,
            'user': user,
            'file_id__isnull': False,
        }

        db_pdfs = PDFDocument.objects.filter(**pdf_filter)
        for pdf in db_pdfs:
            still_on_drive = False
            if pdf.file_id and pdf.file_id in drive_pdf_file_ids:
                still_on_drive = True
            elif pdf.drive_folder_id and pdf.drive_folder_id in drive_pdf_subfolder_ids:
                still_on_drive = True

            if not still_on_drive:
                if pdf.drive_folder_id:
                    still_on_drive = drive_service.file_exists(pdf.drive_folder_id)
                elif pdf.file_id:
                    still_on_drive = drive_service.file_exists(pdf.file_id)

            if not still_on_drive:
                pdf.delete()
                pdf_deleted += 1

        remaining_pdf_file_ids = set(
            PDFDocument.objects.filter(**pdf_filter).values_list('file_id', flat=True)
        )

        for drive_pdf in drive_pdfs:
            file_id = drive_pdf.get('id')
            if file_id in remaining_pdf_file_ids:
                continue

            PDFDocument.objects.create(
                user=user,
                title=drive_pdf.get('name', 'Untitled.pdf'),
                file_id=file_id,
                drive_folder_id=drive_pdf.get('drive_folder_id'),
                file_size=int(drive_pdf.get('size', 0)),
                folder_path=folder_path,
                organization=organization,
                chapter=chapter,
                category=organization.category,
            )
            pdf_synced += 1

    except Exception as e:
        logger.warning(f"PDF sync phase failed for {folder_path}: {e}")

    return {
        'synced': synced,
        'deleted': deleted,
        'pdf_synced': pdf_synced,
        'pdf_deleted': pdf_deleted,
    }
