"""Views for apps.wallet."""

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from apps.core.permissions import HasPermission
from apps.identity.models import User

from .serializers import WalletLookupQuerySerializer, WalletMineQuerySerializer, WalletSerializer
from .services import get_wallet_balance, list_wallet_transactions

_BUSINESS_QUERY_PARAM = OpenApiParameter(
    "business", str, OpenApiParameter.QUERY, required=True, description="The Business to look up."
)
_PASSENGER_QUERY_PARAM = OpenApiParameter(
    "passenger", str, OpenApiParameter.QUERY, required=True, description="The passenger to look up."
)


@extend_schema(parameters=[_BUSINESS_QUERY_PARAM], responses=WalletSerializer)
class WalletMineView(GenericAPIView):
    """GET /wallet/mine/?business= — the passenger's own wallet."""

    permission_classes = [IsAuthenticated]
    serializer_class = WalletSerializer

    def get(self, request: Request) -> Response:
        query = WalletMineQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        business = query.validated_data["business"]
        user = request.user
        assert isinstance(user, User)
        balance = get_wallet_balance(passenger=user, business=business)
        transactions = list_wallet_transactions(passenger=user, business=business)
        return Response(WalletSerializer({**balance, "transactions": transactions}).data)


@extend_schema(
    parameters=[_BUSINESS_QUERY_PARAM, _PASSENGER_QUERY_PARAM], responses=WalletSerializer
)
class WalletLookupView(GenericAPIView):
    """GET /wallet/?business=&passenger= — staff lookup for
    support/disputes."""

    permission_classes = [HasPermission("wallet.view")]
    serializer_class = WalletSerializer

    def get(self, request: Request) -> Response:
        query = WalletLookupQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        business = query.validated_data["business"]
        passenger = query.validated_data["passenger"]
        balance = get_wallet_balance(passenger=passenger, business=business)
        transactions = list_wallet_transactions(passenger=passenger, business=business)
        return Response(WalletSerializer({**balance, "transactions": transactions}).data)
