from __future__ import annotations

import json
import secrets
from copy import deepcopy
from typing import Any, Callable
from uuid import uuid4

from fastapi import Depends, Header, HTTPException

from app.config import settings
from app.schemas import FinancialDefaultsResponse, Permissions, UserSessionResponse

DEFAULT_ROLE_PERMISSIONS: dict[str, dict[str, bool]] = {
    "admin": {
        "canIntakeGold": True,
        "canMeltGold": True,
        "canSellGold": True,
        "canViewCost": True,
        "canViewProfit": True,
        "canViewFormula": True,
        "canManageFinancialDefaults": True,
        "canManageUsers": True,
    },
    "staff": {
        "canIntakeGold": True,
        "canMeltGold": False,
        "canSellGold": True,
        "canViewCost": False,
        "canViewProfit": False,
        "canViewFormula": False,
        "canManageFinancialDefaults": False,
        "canManageUsers": False,
    },
    "staff_intake": {
        "canIntakeGold": True,
        "canMeltGold": False,
        "canSellGold": False,
        "canViewCost": False,
        "canViewProfit": False,
        "canViewFormula": False,
        "canManageFinancialDefaults": False,
        "canManageUsers": False,
    },
    "staff_sell": {
        "canIntakeGold": False,
        "canMeltGold": False,
        "canSellGold": True,
        "canViewCost": False,
        "canViewProfit": False,
        "canViewFormula": False,
        "canManageFinancialDefaults": False,
        "canManageUsers": False,
    },
    "staff_melt": {
        "canIntakeGold": False,
        "canMeltGold": True,
        "canSellGold": False,
        "canViewCost": False,
        "canViewProfit": False,
        "canViewFormula": False,
        "canManageFinancialDefaults": False,
        "canManageUsers": False,
    },
    "staff_intake_melt": {
        "canIntakeGold": True,
        "canMeltGold": True,
        "canSellGold": False,
        "canViewCost": False,
        "canViewProfit": False,
        "canViewFormula": False,
        "canManageFinancialDefaults": False,
        "canManageUsers": False,
    },
}

DEFAULT_USERS: list[dict[str, Any]] = [
    {
        "username": "admin",
        "password": "1976123",
        "displayName": "管理员",
        "role": "admin",
    },
    {
        "username": "de",
        "password": "de123",
        "displayName": "de",
        "role": "staff_intake_melt",
    },
    {
        "username": "jian",
        "password": "jian456",
        "displayName": "jian",
        "role": "staff_sell",
    },
    {
        "username": "intake",
        "password": "intake123",
        "displayName": "intake",
        "role": "staff_intake",
    },
]


def _build_permissions(role: str, overrides: dict[str, Any] | None = None) -> Permissions:
    payload = deepcopy(DEFAULT_ROLE_PERMISSIONS.get(role, DEFAULT_ROLE_PERMISSIONS["staff"]))
    if overrides:
        payload.update({key: bool(value) for key, value in overrides.items() if key in payload})
    return Permissions(**payload)


def _load_users() -> dict[str, dict[str, Any]]:
    raw_users = settings.app_users_json.strip()
    source = DEFAULT_USERS
    if raw_users:
        try:
            parsed = json.loads(raw_users)
            if isinstance(parsed, list) and parsed:
                source = parsed
        except json.JSONDecodeError:
            source = DEFAULT_USERS

    users: dict[str, dict[str, Any]] = {}
    for raw_user in source:
        username = str(raw_user.get("username", "")).strip()
        password = str(raw_user.get("password", ""))
        if not username or not password:
            continue
        role = str(raw_user.get("role", "staff")).strip() or "staff"
        permissions = _build_permissions(role, raw_user.get("permissions"))
        users[username] = {
            "username": username,
            "password": password,
            "displayName": str(raw_user.get("displayName", username)).strip() or username,
            "role": role,
            "permissions": permissions,
        }
    return users


USERS_BY_USERNAME = _load_users()
SESSIONS_BY_TOKEN: dict[str, UserSessionResponse] = {}
FINANCIAL_DEFAULTS = FinancialDefaultsResponse(usdToUsdtRate=settings.default_usd_to_usdt_rate)


def _build_user_session(raw_user: dict[str, Any]) -> UserSessionResponse:
    return UserSessionResponse(
        username=raw_user["username"],
        displayName=raw_user["displayName"],
        role=raw_user["role"],
        permissions=raw_user["permissions"],
    )


def authenticate_user(username: str, password: str) -> UserSessionResponse:
    raw_user = USERS_BY_USERNAME.get(username.strip())
    if not raw_user or not secrets.compare_digest(raw_user["password"], password):
        raise HTTPException(status_code=401, detail="用户名或密码不正确")
    return _build_user_session(raw_user)


def create_session(user: UserSessionResponse) -> str:
    token = f"session-{uuid4().hex}"
    SESSIONS_BY_TOKEN[token] = user
    return token


def remove_session(token: str) -> None:
    SESSIONS_BY_TOKEN.pop(token, None)


def _extract_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="请先登录")
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="登录状态无效")
    return authorization[len(prefix):].strip()


def get_current_user(authorization: str | None = Header(default=None)) -> UserSessionResponse:
    token = _extract_token(authorization)
    user = SESSIONS_BY_TOKEN.get(token)
    if not user:
        raise HTTPException(status_code=401, detail="登录已失效，请重新登录")
    return user


def require_permissions(*permission_names: str) -> Callable[[UserSessionResponse], UserSessionResponse]:
    def dependency(user: UserSessionResponse = Depends(get_current_user)) -> UserSessionResponse:
        missing = [name for name in permission_names if not getattr(user.permissions, name, False)]
        if missing:
            raise HTTPException(status_code=403, detail="当前账号没有权限执行这个操作")
        return user

    return dependency


def require_any_permission(*permission_names: str) -> Callable[[UserSessionResponse], UserSessionResponse]:
    def dependency(user: UserSessionResponse = Depends(get_current_user)) -> UserSessionResponse:
        if any(getattr(user.permissions, name, False) for name in permission_names):
            return user
        raise HTTPException(status_code=403, detail="当前账号没有权限访问这个内容")

    return dependency


def get_financial_defaults() -> FinancialDefaultsResponse:
    return FinancialDefaultsResponse(**FINANCIAL_DEFAULTS.model_dump())


def update_financial_defaults(*, usd_to_usdt_rate: float) -> FinancialDefaultsResponse:
    global FINANCIAL_DEFAULTS
    FINANCIAL_DEFAULTS = FinancialDefaultsResponse(usdToUsdtRate=usd_to_usdt_rate)
    return get_financial_defaults()
