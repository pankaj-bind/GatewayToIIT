"""
Authentication Views
Thin controllers delegating to services/selectors
All token operations use HttpOnly cookies for XSS prevention
"""
import os
from django.conf import settings
from rest_framework import status
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny, IsAuthenticated

from .serializers import SignupSerializer, LoginSerializer, UserSerializer
from .services import AuthService
from .selectors import UserSelector
from .exceptions import AuthenticationError


def _signup_enabled() -> bool:
    return os.environ.get('SIGNUP_ENABLED', 'False').lower() == 'true'


def _email_allowed(email: str) -> bool:
    """Single-user lockdown. If ALLOWED_LOGIN_EMAILS is set, only those emails
    can log in. Empty / unset = no restriction (dev/local)."""
    raw = os.environ.get('ALLOWED_LOGIN_EMAILS', '').strip()
    if not raw:
        return True
    allowed = {e.strip().lower() for e in raw.split(',') if e.strip()}
    return email.strip().lower() in allowed


class CookieTokenMixin:
    """
    Mixin providing methods to set/clear JWT tokens as HttpOnly cookies.
    """

    def set_auth_cookies(self, response: Response, access_token: str, refresh_token: str) -> Response:
        """Set access and refresh tokens as HttpOnly cookies."""
        response.set_cookie(
            key=settings.AUTH_COOKIE,
            value=access_token,
            max_age=settings.AUTH_COOKIE_ACCESS_MAX_AGE,
            secure=settings.AUTH_COOKIE_SECURE,
            httponly=settings.AUTH_COOKIE_HTTP_ONLY,
            samesite=settings.AUTH_COOKIE_SAMESITE,
            path=settings.AUTH_COOKIE_PATH,
        )
        response.set_cookie(
            key=settings.AUTH_COOKIE_REFRESH,
            value=refresh_token,
            max_age=settings.AUTH_COOKIE_REFRESH_MAX_AGE,
            secure=settings.AUTH_COOKIE_SECURE,
            httponly=settings.AUTH_COOKIE_HTTP_ONLY,
            samesite=settings.AUTH_COOKIE_SAMESITE,
            path=settings.AUTH_COOKIE_PATH,
        )
        return response

    def clear_auth_cookies(self, response: Response) -> Response:
        """Clear authentication cookies on logout."""
        response.delete_cookie(
            key=settings.AUTH_COOKIE,
            path=settings.AUTH_COOKIE_PATH,
        )
        response.delete_cookie(
            key=settings.AUTH_COOKIE_REFRESH,
            path=settings.AUTH_COOKIE_PATH,
        )
        return response


class SignupView(CookieTokenMixin, APIView):
    """
    POST /api/auth/signup/
    Create new user account with email verification pending.
    """
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        if not _signup_enabled():
            return Response(
                {'success': False, 'error': {'message': 'Signup is disabled.'}},
                status=status.HTTP_403_FORBIDDEN,
            )

        serializer = SignupSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        email = serializer.validated_data['email']
        if not _email_allowed(email):
            return Response(
                {'success': False, 'error': {'message': 'This email is not authorized.'}},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Delegate to service layer
        user = AuthService.create_user(
            email=email,
            username=serializer.validated_data['username'],
            password=serializer.validated_data['password'],
        )

        # Generate tokens and set cookies
        access_token, refresh_token = AuthService.generate_tokens(user)
        
        response = Response(
            {
                'success': True,
                'message': 'Account created successfully',
                'user': UserSerializer(user).data,
            },
            status=status.HTTP_201_CREATED
        )
        
        return self.set_auth_cookies(response, access_token, refresh_token)


class LoginView(CookieTokenMixin, APIView):
    """
    POST /api/auth/login/
    Authenticate user and set JWT cookies.
    """
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        email = serializer.validated_data['email']
        if not _email_allowed(email):
            # Same generic error as wrong-password to avoid email enumeration.
            raise AuthenticationError('Invalid credentials')

        # Delegate authentication to service
        user = AuthService.authenticate_user(
            email=email,
            password=serializer.validated_data['password'],
        )

        # Generate tokens
        access_token, refresh_token = AuthService.generate_tokens(user)
        
        response = Response(
            {
                'success': True,
                'message': 'Login successful',
                'user': UserSerializer(user).data,
            },
            status=status.HTTP_200_OK
        )
        
        return self.set_auth_cookies(response, access_token, refresh_token)


class LogoutView(CookieTokenMixin, APIView):
    """
    POST /api/auth/logout/
    Blacklist refresh token and clear cookies.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request):
        # Get refresh token from cookie
        refresh_token = request.COOKIES.get(settings.AUTH_COOKIE_REFRESH)
        
        # Blacklist the token if present
        if refresh_token:
            AuthService.blacklist_token(refresh_token)

        response = Response(
            {
                'success': True,
                'message': 'Logged out successfully',
            },
            status=status.HTTP_200_OK
        )
        
        return self.clear_auth_cookies(response)


class TokenRefreshView(CookieTokenMixin, APIView):
    """
    POST /api/auth/refresh/
    Refresh access token using refresh token from cookie.
    Implements silent token rotation.
    """
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        refresh_token = request.COOKIES.get(settings.AUTH_COOKIE_REFRESH)
        
        if not refresh_token:
            return Response(
                {
                    'success': False,
                    'error': {'message': 'Refresh token not found'},
                },
                status=status.HTTP_401_UNAUTHORIZED
            )

        # Delegate to service - handles rotation and blacklisting
        access_token, new_refresh_token = AuthService.refresh_access_token(refresh_token)

        response = Response(
            {
                'success': True,
                'message': 'Token refreshed successfully',
            },
            status=status.HTTP_200_OK
        )
        
        return self.set_auth_cookies(response, access_token, new_refresh_token)


class MeView(APIView):
    """
    GET /api/auth/me/
    Get current authenticated user's profile.
    Used to verify authentication state on app load.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user_data = UserSelector.get_user_profile(request.user)
        
        return Response(
            {
                'success': True,
                'user': user_data,
            },
            status=status.HTTP_200_OK
        )


class DashboardView(APIView):
    """
    GET /api/dashboard/
    Protected endpoint returning user dashboard data.
    Demonstrates protected route pattern.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        dashboard_data = UserSelector.get_user_dashboard_data(request.user)
        
        return Response(
            {
                'success': True,
                'data': dashboard_data,
            },
            status=status.HTTP_200_OK
        )
